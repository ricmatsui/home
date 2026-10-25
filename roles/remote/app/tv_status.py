import threading


class TvStatus:
    """What the remote last learned about the TV, for pages to follow.

    Written from the control loop's thread, read from request threads. A
    state of None means nothing current is known, such as at startup or
    after a channel drops and before the next presence check.
    """

    def __init__(self):
        self._condition = threading.Condition()
        self._version = 0
        self._state = None

    def set(self, state):
        with self._condition:
            if state == self._state:
                return

            self._state = state
            self._version += 1
            self._condition.notify_all()

    def wait(self, after, timeout):
        """Return (version, state) once newer than after, or None on timeout.

        A reader passing None has seen nothing yet and gets the current
        state at once.
        """
        with self._condition:
            if not self._condition.wait_for(
                lambda: self._version != after, timeout
            ):
                return None

            return self._version, self._state
