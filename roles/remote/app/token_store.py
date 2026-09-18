import os


class TokenStore:
    """The TV's pairing token, as last seen from the TV.

    The TV can hand back a new token on any connection, including ones we
    authenticated with the previous token, so this is the authority rather
    than anything baked into the container at deploy time. An absent or
    empty file means unpaired: connect without a token and the TV prompts.
    """

    def __init__(self, path):
        self.path = path

    def read(self):
        try:
            token = self.path.read_text().strip()
        except OSError:
            return None

        return token or None

    def write(self, token):
        self.path.parent.mkdir(parents=True, exist_ok=True)

        # Written whole and swapped in: this lives on gluster, and a reader
        # that caught a half-written token would look unpaired and re-prompt.
        temporary = self.path.with_name(self.path.name + '.new')

        with temporary.open('w') as file:
            file.write(token)
            file.flush()
            os.fsync(file.fileno())

        os.replace(temporary, self.path)

    def clear(self):
        self.path.unlink(missing_ok=True)
