import json


class Recordings:
    def __init__(self, path):
        self.path = path

    def append(self, gesture, image):
        self.path.parent.mkdir(parents=True, exist_ok=True)

        with self.path.open('a') as file:
            file.write(json.dumps(dict(gesture=gesture, image=image)) + '\n')

    def delete_last(self):
        if not self.path.exists():
            return False

        lines = self.path.read_text().splitlines(keepends=True)

        if not lines:
            return False

        self.path.write_text(''.join(lines[:-1]))
        return True
