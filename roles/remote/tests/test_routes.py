import json
import shutil
from pathlib import Path

import pytest

import app as app_module
from app import create_app
from app.recordings import Recordings


class FakeControl:
    def __init__(self):
        self.sent = []

    def send(self, message):
        self.sent.append(message)


@pytest.fixture
def control():
    return FakeControl()


@pytest.fixture
def static_root(tmp_path):
    """An isolated copy of static/, so tests never touch real build inputs.

    static/model/ is excluded: it is the Ansible fetch's output, and after a
    deploy it holds real weights. A fixture that wrote into the role's own
    static/model/ would clobber them, and its teardown would delete them.
    Tests that need a fetched model use the fetched_model fixture.
    """
    root = tmp_path / 'static'
    shutil.copytree(
        Path(__file__).parent.parent / 'static',
        root,
        ignore=shutil.ignore_patterns('model'),
    )
    return root


@pytest.fixture
def fetched_model(static_root):
    """Simulates the Ansible fetch having run.

    The label vector is seeded from the committed roster, which is what a
    freshly trained model would have been published with.
    """
    directory = static_root / 'model'
    directory.mkdir()
    (directory / 'gestures.json').write_text(
        (static_root / 'gestures.json').read_text()
    )
    (directory / 'model.json').write_text('{"format": "layers-model"}')
    return directory


@pytest.fixture
def client(control, static_root, tmp_path):
    app = create_app(
        control=control,
        recordings=Recordings(tmp_path / 'recordings.jsonl'),
        static=static_root,
    )
    app.config['TESTING'] = True
    return app.test_client()


def test_index_renders(client):
    response = client.get('/')

    assert response.status_code == 200
    assert b'debug-canvas' in response.data
    assert b'/static/app.js' in response.data
    assert b'/static/styles.css' in response.data
    assert b'unpkg.com' not in response.data
    assert b'@tensorflow/tfjs@4.20.0' in response.data


def test_the_roster_is_served_without_caching(client):
    """The roster is committed, so it is served with no fixture."""
    response = client.get('/gestures.json')

    assert response.status_code == 200
    assert response.cache_control.no_cache
    assert json.loads(response.data)[0]['name'] == 'up'


def test_the_label_vector_is_served_from_the_fetched_model(client, fetched_model):
    response = client.get('/model/gestures.json')

    assert response.status_code == 200
    assert response.cache_control.no_cache
    assert json.loads(response.data)[0]['name'] == 'up'


def test_the_label_vector_404s_when_the_model_has_not_been_fetched(client):
    """A build that skipped the Ansible fetch must fail visibly, not serve
    the roster as though it were the model's label vector."""
    response = client.get('/model/gestures.json')

    assert response.status_code == 404


def test_control_enqueues_the_parsed_message(client, control):
    message = {'kind': 'up', 'data': {'method': 'ms.remote.control'}}

    response = client.post('/control', data={'message': json.dumps(message)})

    assert response.status_code == 204
    assert control.sent == [message]


def test_record_appends_a_recording(client, tmp_path):
    response = client.post(
        '/record',
        data={'gesture': 'circle', 'image': 'data:image/png;base64,AAAA'},
    )

    assert response.status_code == 204
    assert json.loads(
        (tmp_path / 'recordings.jsonl').read_text().splitlines()[0]
    )['gesture'] == 'circle'


def test_delete_on_an_empty_log_still_returns_204(client):
    response = client.post('/delete')

    assert response.status_code == 204


def test_manifest_is_served_from_the_root(client):
    response = client.get('/manifest.json')

    assert response.status_code == 200
    assert json.loads(response.data)['short_name'] == 'Remote'


def test_model_files_are_served_without_caching(client, fetched_model):
    response = client.get('/model/model.json')

    assert response.status_code == 200
    assert response.cache_control.no_cache


def test_a_missing_model_file_is_a_404(client):
    response = client.get('/model/nope.json')

    assert response.status_code == 404


class FakeTvControl:
    def __init__(self, **keywords):
        self.keywords = keywords
        FakeTvControl.built = self

    def start(self):
        pass


def test_create_app_pairs_through_a_token_file_not_the_environment(
    monkeypatch, tmp_path, static_root
):
    """Nothing is baked in at deploy time: an unpaired container starts fine
    and the TV prompts on the first command."""
    monkeypatch.setattr(app_module, 'TvControl', FakeTvControl)
    monkeypatch.setattr(app_module, 'local_addresses', lambda: ['10.0.0.2/24'])
    monkeypatch.setenv('REMOTE_TV_IP', '10.0.0.5')
    monkeypatch.setenv('REMOTE_TV_MAC', 'aa:bb:cc:dd:ee:ff')
    monkeypatch.setenv('REMOTE_TV_CLIENT_NAME', 'Remote')
    monkeypatch.setenv('REMOTE_LAN_CIDR', '10.0.0.0/24')
    monkeypatch.setenv('REMOTE_TOKEN_PATH', str(tmp_path / 'token'))
    monkeypatch.setenv('RECORDINGS_PATH', str(tmp_path / 'recordings.jsonl'))
    monkeypatch.delenv('REMOTE_TV_TOKEN', raising=False)

    create_app(static=static_root)

    keywords = FakeTvControl.built.keywords
    assert keywords['token_store'].path == tmp_path / 'token'
    assert keywords['lan'].broadcast_ip == '10.0.0.255'
