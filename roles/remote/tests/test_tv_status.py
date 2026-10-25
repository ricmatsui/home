import threading

from app.tv_status import TvStatus


def test_a_fresh_status_is_unknown():
    """Nothing has been learned about the TV yet, so there is nothing to show."""
    assert TvStatus().wait(after=None, timeout=0) == (0, None)


def test_wait_returns_at_once_for_a_reader_that_is_behind():
    status = TvStatus()
    status.set('off')

    assert status.wait(after=0, timeout=0) == (1, 'off')


def test_wait_times_out_for_a_reader_that_is_current():
    status = TvStatus()
    status.set('off')

    assert status.wait(after=1, timeout=0) is None


def test_setting_the_same_state_wakes_nobody():
    """The presence check reports Off every few seconds; a stream must not
    send that each time."""
    status = TvStatus()
    status.set('off')
    status.set('off')

    assert status.wait(after=1, timeout=0) is None


def test_a_change_wakes_a_waiting_reader():
    status = TvStatus()
    status.set('off')
    seen = []

    reader = threading.Thread(target=lambda: seen.append(status.wait(after=1, timeout=2)))
    reader.start()
    status.set('connecting')
    reader.join()

    assert seen == [(2, 'connecting')]
