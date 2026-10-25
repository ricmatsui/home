import asyncio
import base64
import io
import json
import queue
import time
from urllib.parse import parse_qs, urlparse

import pytest

import app.control as control_module
from app.control import ChannelTimeout, TvControl, Unauthorized
from app.network import LanInterface
from app.token_store import TokenStore
from app.tv_status import TvStatus


@pytest.fixture
def token_store(tmp_path):
    return TokenStore(tmp_path / 'token')


class RecordingStatus(TvStatus):
    def __init__(self):
        super().__init__()
        self.history = []

    def set(self, state):
        if not self.history or self.history[-1] != state:
            self.history.append(state)

        super().set(state)


def make_control(token_store, client_name='Remote', status=None):
    return TvControl(
        ip='10.0.0.5',
        mac='aa:bb:cc:dd:ee:ff',
        client_name=client_name,
        token_store=token_store,
        lan=LanInterface(source_ip='10.0.0.2', broadcast_ip='10.0.0.255'),
        status=status or TvStatus(),
    )


def query_of(url):
    return parse_qs(urlparse(url).query)


def test_url_omits_the_token_when_unpaired(token_store):
    """A token param the TV cannot match is worse than none: with none it
    prompts, which is the whole bootstrap path."""
    query = query_of(make_control(token_store)._url())

    assert 'token' not in query


def test_url_carries_the_token_once_paired(token_store):
    token_store.write('12345678')

    assert query_of(make_control(token_store)._url())['token'] == ['12345678']


def test_url_sends_the_client_name_base64_encoded(token_store):
    query = query_of(make_control(token_store, client_name='Remote')._url())

    assert query['name'] == [base64.b64encode(b'Remote').decode()]


def test_url_percent_encodes_a_name_whose_base64_contains_plus(token_store):
    """base64 of a curly apostrophe yields '+', which a query string decodes
    as a space. The TV would file that under a different client name and the
    token would never match again."""
    url = make_control(token_store, client_name='Ricardo’s Remote')._url()

    assert '%2B' in url
    assert query_of(url)['name'] == [
        base64.b64encode('Ricardo’s Remote'.encode()).decode()
    ]


def test_url_picks_up_a_token_written_after_startup(token_store):
    """Pairing happens while the process is running, so the token cannot be
    read once at construction."""
    control = make_control(token_store)
    token_store.write('12345678')

    assert query_of(control._url())['token'] == ['12345678']


class FakeWebsocket:
    """Records recv/send in order, so a send before the handshake is visible."""

    def __init__(self, incoming):
        self.incoming = list(incoming)
        self.log = []
        self.sent_something = asyncio.Event()

    async def recv(self):
        if not self.incoming:
            await asyncio.Event().wait()

        message = self.incoming.pop(0)
        self.log.append(('recv', message))

        if isinstance(message, Exception):
            raise message

        return message

    async def send(self, data):
        self.log.append(('send', data))
        self.sent_something.set()


class FakeConnect:
    def __init__(self, websocket):
        self.websocket = websocket

    async def __aenter__(self):
        return self.websocket

    async def __aexit__(self, *error):
        return False


class FailingConnect:
    """websockets.connect() returns synchronously; a refused connection
    surfaces from __aenter__, after real network I/O has yielded."""

    async def __aenter__(self):
        await asyncio.sleep(0)
        raise OSError('connection refused')

    async def __aexit__(self, *error):
        return False


CONNECT = '{"event": "ms.channel.connect", "data": {"token": "12345678"}}'
UNAUTHORIZED = '{"event": "ms.channel.unauthorized"}'
TIMED_OUT = '{"event": "ms.channel.timeOut"}'
CLIENT_CONNECT = '{"event": "ms.channel.clientConnect"}'


def open_channel(control, incoming):
    websocket = FakeWebsocket(incoming)
    asyncio.run(control._open_channel(websocket, timeout=1))
    return websocket


def test_open_channel_stores_the_token_from_a_first_pairing(token_store):
    open_channel(make_control(token_store), [CONNECT])

    assert token_store.read() == '12345678'


def test_open_channel_stores_a_rotated_token(token_store):
    """The TV can hand back a new token on a connection we authenticated
    with the old one; dropping it strands us on the next connect."""
    token_store.write('87654321')

    open_channel(make_control(token_store), [CONNECT])

    assert token_store.read() == '12345678'


def test_open_channel_keeps_an_unchanged_token(token_store):
    token_store.write('12345678')

    open_channel(make_control(token_store), [CONNECT])

    assert token_store.read() == '12345678'


def test_open_channel_ignores_chatter_before_the_connect_event(token_store):
    open_channel(make_control(token_store), [CLIENT_CONNECT, CONNECT])

    assert token_store.read() == '12345678'


def test_open_channel_rejects_an_unauthorized_channel(token_store):
    with pytest.raises(Unauthorized):
        open_channel(make_control(token_store), [UNAUTHORIZED])


def test_open_channel_reports_a_timed_out_channel_separately(token_store):
    """Connected but asleep is a wake-on-lan case, not a pairing case."""
    with pytest.raises(ChannelTimeout):
        open_channel(make_control(token_store), [TIMED_OUT])


KEY_MESSAGE = {
    'kind': 'click',
    'data': {'method': 'ms.remote.control', 'params': {'DataOfCmd': 'KEY_ENTER'}},
}


async def wait_until(predicate, timeout=2):
    async def poll():
        while not predicate():
            await asyncio.sleep(0.01)

    await asyncio.wait_for(poll(), timeout)


def drive(
    control, monkeypatch, predicate, websocket=None, connect=None, gestures=(KEY_MESSAGE,)
):
    """Run the message loop until predicate holds, then stop it."""
    if connect is None:
        def connect(*args, **keywords):
            return FakeConnect(websocket)

    monkeypatch.setattr(control_module.websockets, 'connect', connect)

    async def scenario():
        handoff = queue.Queue()
        task = asyncio.create_task(control._process_messages(handoff))
        await asyncio.sleep(0)
        message_queue = handoff.get()

        for gesture in gestures:
            message_queue.sync_q.put(gesture)

        try:
            await wait_until(predicate)
        finally:
            task.cancel()

    asyncio.run(scenario())


@pytest.fixture
def wakes(monkeypatch):
    calls = []
    monkeypatch.setattr(
        control_module, 'send_magic_packet', lambda *a, **k: calls.append(k)
    )
    return calls


def test_nothing_is_sent_before_the_channel_is_open(token_store, monkeypatch, wakes):
    """The websocket handshake is not the channel handshake; a remote key
    sent in between is dropped by the TV."""
    token_store.write('12345678')
    websocket = FakeWebsocket([CLIENT_CONNECT, CONNECT])

    drive(
        make_control(token_store),
        monkeypatch,
        lambda: websocket.sent_something.is_set(),
        websocket=websocket,
    )

    assert [entry[0] for entry in websocket.log] == ['recv', 'recv', 'send']


def test_an_unauthorized_channel_clears_the_token(token_store, monkeypatch, wakes):
    """A token the TV has rejected will be rejected again; dropping it is
    what lets the next gesture re-pair."""
    token_store.write('87654321')
    websocket = FakeWebsocket([UNAUTHORIZED])

    drive(
        make_control(token_store),
        monkeypatch,
        lambda: token_store.read() is None,
        websocket=websocket,
    )

    assert wakes == []


def test_a_refused_connection_still_wakes_the_tv(token_store, monkeypatch, wakes):
    def refuse(*args, **keywords):
        return FailingConnect()

    drive(make_control(token_store), monkeypatch, lambda: wakes, connect=refuse)

    assert wakes


def test_a_dropped_channel_logs_connect_and_disconnect(
    token_store, monkeypatch, wakes, caplog
):
    token_store.write('12345678')
    websocket = FakeWebsocket([CONNECT, OSError('connection lost')])
    caplog.set_level('INFO', logger=control_module.__name__)

    drive(
        make_control(token_store),
        monkeypatch,
        lambda: 'websocket disconnected' in caplog.messages,
        websocket=websocket,
    )

    lifecycle = [
        message for message in caplog.messages if message.startswith('websocket')
    ]
    assert lifecycle == ['websocket connected', 'websocket disconnected']


def test_a_refused_connection_logs_no_disconnect(
    token_store, monkeypatch, wakes, caplog
):
    """A socket that never opened was never connected."""
    caplog.set_level('INFO', logger=control_module.__name__)

    def refuse(*args, **keywords):
        return FailingConnect()

    drive(make_control(token_store), monkeypatch, lambda: wakes, connect=refuse)

    assert not [
        message for message in caplog.messages if message.startswith('websocket')
    ]


def capture_connect(control, monkeypatch, websocket, predicate):
    captured = []

    def connect(*args, **keywords):
        captured.append(keywords)
        return FakeConnect(websocket)

    drive(control, monkeypatch, predicate, connect=connect)
    return captured


def test_pairing_waits_without_keepalive_pings(token_store, monkeypatch, wakes):
    """The socket stays open while a human walks to the TV and accepts; a 2s
    pong deadline would close it long before they get there."""
    captured = capture_connect(
        make_control(token_store),
        monkeypatch,
        FakeWebsocket([CONNECT]),
        lambda: token_store.read() is not None,
    )

    assert captured[0]['ping_interval'] is None
    assert captured[0]['open_timeout'] == 60


def test_a_paired_connection_keeps_failing_fast(token_store, monkeypatch, wakes):
    """Once paired there is nobody to wait for: fail fast so wake-on-lan
    still feels immediate."""
    token_store.write('12345678')

    websocket = FakeWebsocket([CONNECT])
    captured = capture_connect(
        make_control(token_store),
        monkeypatch,
        websocket,
        lambda: websocket.sent_something.is_set(),
    )

    assert captured[0]['ping_interval'] == 5
    assert captured[0]['open_timeout'] == 2


def test_open_channel_reports_a_completed_pairing(token_store):
    websocket = FakeWebsocket([CONNECT])

    assert asyncio.run(
        make_control(token_store)._open_channel(websocket, timeout=1)
    ) is True


def test_open_channel_does_not_report_a_mere_rotation_as_pairing(token_store):
    """Rotation happens on a connection that already has keepalive; only
    going from unpaired to paired needs the socket rebuilt."""
    token_store.write('87654321')
    websocket = FakeWebsocket([CONNECT])

    assert asyncio.run(
        make_control(token_store)._open_channel(websocket, timeout=1)
    ) is False


def test_pairing_reconnects_so_keepalive_takes_effect(token_store, monkeypatch, wakes):
    """The pairing socket is built without keepalive and the library starts
    that task once, at open; it cannot be turned on later."""
    pairing = FakeWebsocket([CONNECT])
    established = FakeWebsocket([CONNECT])
    remaining = [pairing, established]
    captured = []

    def connect(*args, **keywords):
        captured.append(keywords)
        return FakeConnect(remaining.pop(0) if remaining else established)

    drive(
        make_control(token_store),
        monkeypatch,
        lambda: established.sent_something.is_set(),
        connect=connect,
    )

    assert [keywords['ping_interval'] for keywords in captured[:2]] == [None, 5]
    assert [entry[0] for entry in pairing.log] == ['recv']


def tv_power(monkeypatch, control, on):
    probes = []

    async def tv_is_on():
        probes.append(on)
        return on

    monkeypatch.setattr(control, '_tv_is_on', tv_is_on)
    monkeypatch.setattr(control_module, 'PRESENCE_INTERVAL', 0.01)
    return probes


def after(seconds):
    deadline = time.monotonic() + seconds
    return lambda: time.monotonic() > deadline


def counting_connect(websockets):
    """Hands out websockets in order, repeating the last one."""
    remaining = list(websockets)
    captured = []

    def connect(*args, **keywords):
        captured.append(keywords)
        return FakeConnect(remaining.pop(0) if len(remaining) > 1 else remaining[0])

    return connect, captured


def test_a_paired_remote_connects_once_the_tv_is_on(token_store, monkeypatch, wakes):
    """The channel is open before the gesture, so the gesture skips the
    handshake."""
    token_store.write('12345678')
    control = make_control(token_store)
    tv_power(monkeypatch, control, on=True)
    connect, captured = counting_connect([FakeWebsocket([CONNECT])])

    drive(control, monkeypatch, lambda: captured, connect=connect, gestures=())

    assert wakes == []


def test_a_gesture_reuses_the_preconnected_channel(token_store, monkeypatch, wakes):
    token_store.write('12345678')
    control = make_control(token_store)
    tv_power(monkeypatch, control, on=True)
    websocket = FakeWebsocket([CONNECT])
    connect, captured = counting_connect([websocket])

    async def scenario():
        handoff = queue.Queue()
        task = asyncio.create_task(control._process_messages(handoff))
        await asyncio.sleep(0)
        message_queue = handoff.get()

        try:
            await wait_until(lambda: websocket.log)
            message_queue.sync_q.put(KEY_MESSAGE)
            await wait_until(lambda: websocket.sent_something.is_set())
        finally:
            task.cancel()

    monkeypatch.setattr(control_module.websockets, 'connect', connect)
    asyncio.run(scenario())

    assert len(captured) == 1
    assert [entry[0] for entry in websocket.log] == ['recv', 'send']


def test_an_unpaired_remote_never_preconnects(token_store, monkeypatch, wakes):
    """Every unpaired connect puts the pairing prompt on the TV."""
    control = make_control(token_store)
    tv_power(monkeypatch, control, on=True)
    connect, captured = counting_connect([FakeWebsocket([CONNECT])])

    drive(control, monkeypatch, after(0.1), connect=connect, gestures=())

    assert captured == []


def test_a_tv_that_is_off_is_left_alone(token_store, monkeypatch, wakes):
    token_store.write('12345678')
    control = make_control(token_store)
    probes = tv_power(monkeypatch, control, on=False)
    connect, captured = counting_connect([FakeWebsocket([CONNECT])])

    drive(control, monkeypatch, lambda: len(probes) >= 3, connect=connect, gestures=())

    assert captured == []
    assert wakes == []


def test_a_failed_preconnect_never_wakes_the_tv(token_store, monkeypatch, wakes):
    """Nobody asked for the TV; waking it is a gesture's call to make."""
    token_store.write('12345678')
    control = make_control(token_store)
    tv_power(monkeypatch, control, on=True)
    attempts = []

    def refuse(*args, **keywords):
        attempts.append(keywords)
        return FailingConnect()

    drive(control, monkeypatch, lambda: len(attempts) >= 3, connect=refuse, gestures=())

    assert wakes == []


def test_a_channel_that_closes_while_idle_goes_back_to_watching(
    token_store, monkeypatch, wakes
):
    token_store.write('12345678')
    control = make_control(token_store)
    tv_power(monkeypatch, control, on=True)
    connect, captured = counting_connect(
        [
            FakeWebsocket([CONNECT, ConnectionError('tv went away')]),
            FakeWebsocket([CONNECT]),
        ]
    )

    drive(control, monkeypatch, lambda: len(captured) >= 2, connect=connect, gestures=())

    assert wakes == []


def power_state_response(monkeypatch, state=None, error=None):
    def urlopen(url, timeout):
        if error is not None:
            raise error

        return io.BytesIO(json.dumps({'device': {'PowerState': state}}).encode())

    monkeypatch.setattr(control_module.urllib.request, 'urlopen', urlopen)


@pytest.mark.parametrize(
    ('state', 'error', 'expected'),
    [
        ('on', None, True),
        ('standby', None, False),
        (None, None, False),
        (None, OSError('no route to host'), False),
    ],
)
def test_tv_is_on_reads_the_power_state(token_store, monkeypatch, state, error, expected):
    power_state_response(monkeypatch, state=state, error=error)

    assert asyncio.run(make_control(token_store)._tv_is_on()) is expected


def test_an_unpaired_remote_reports_unpaired_without_waiting(token_store, monkeypatch, wakes):
    """No presence check runs unpaired, so there is nothing to wait for."""
    status = RecordingStatus()

    drive(
        make_control(token_store, status=status),
        monkeypatch,
        lambda: status.history,
        connect=lambda *a, **k: FakeConnect(FakeWebsocket([])),
        gestures=(),
    )

    assert status.history == ['unpaired']


def test_a_tv_in_standby_reports_off(token_store, monkeypatch, wakes):
    token_store.write('12345678')
    status = RecordingStatus()
    control = make_control(token_store, status=status)
    tv_power(monkeypatch, control, on=False)

    drive(control, monkeypatch, lambda: status.history, gestures=())

    assert status.history == ['off']


def test_a_preconnected_channel_reports_connecting_then_connected(
    token_store, monkeypatch, wakes
):
    token_store.write('12345678')
    status = RecordingStatus()
    control = make_control(token_store, status=status)
    tv_power(monkeypatch, control, on=True)
    connect, captured = counting_connect([FakeWebsocket([CONNECT])])

    drive(
        control,
        monkeypatch,
        lambda: 'connected' in status.history,
        connect=connect,
        gestures=(),
    )

    assert status.history == ['connecting', 'connected']


def test_a_gesture_that_finds_the_tv_asleep_reports_waking_until_connected(
    token_store, monkeypatch, wakes
):
    """The retries after a wake are still the wake, not fresh connects."""
    token_store.write('12345678')
    status = RecordingStatus()
    awake = FakeWebsocket([CONNECT])
    connect, captured = counting_connect(
        [FakeWebsocket([TIMED_OUT]), FakeWebsocket([TIMED_OUT]), awake]
    )

    drive(
        make_control(token_store, status=status),
        monkeypatch,
        lambda: awake.sent_something.is_set(),
        connect=connect,
    )

    assert status.history == ['connecting', 'waking', 'connected']


def test_a_refused_token_reports_unpaired(token_store, monkeypatch, wakes):
    token_store.write('87654321')
    status = RecordingStatus()

    drive(
        make_control(token_store, status=status),
        monkeypatch,
        lambda: token_store.read() is None and status.history[-1] == 'unpaired',
        websocket=FakeWebsocket([UNAUTHORIZED]),
    )

    assert status.history == ['connecting', 'unpaired']


def test_a_dropped_channel_reports_nothing_known_until_the_next_check(
    token_store, monkeypatch, wakes
):
    """Keepalive noticing the TV leave says nothing about whether it is off;
    the presence check says that."""
    token_store.write('12345678')
    status = RecordingStatus()
    control = make_control(token_store, status=status)
    tv_power(monkeypatch, control, on=True)
    connect, captured = counting_connect(
        [FakeWebsocket([CONNECT, ConnectionError('tv went away')])]
    )

    drive(
        control,
        monkeypatch,
        lambda: len(status.history) >= 3,
        connect=connect,
        gestures=(),
    )

    assert status.history[:3] == ['connecting', 'connected', None]
