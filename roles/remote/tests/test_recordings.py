import json

from app.recordings import Recordings


def test_append_writes_one_json_line(tmp_path):
    recordings = Recordings(tmp_path / 'recordings.jsonl')

    recordings.append('circle', 'data:image/png;base64,AAAA')

    lines = (tmp_path / 'recordings.jsonl').read_text().splitlines()
    assert len(lines) == 1
    assert json.loads(lines[0]) == {
        'gesture': 'circle',
        'image': 'data:image/png;base64,AAAA',
    }


def test_append_creates_the_parent_directory(tmp_path):
    recordings = Recordings(tmp_path / 'data' / 'recordings.jsonl')

    recordings.append('up', 'data:image/png;base64,AAAA')

    assert (tmp_path / 'data' / 'recordings.jsonl').exists()


def test_delete_last_removes_only_the_final_line(tmp_path):
    recordings = Recordings(tmp_path / 'recordings.jsonl')
    recordings.append('up', 'a')
    recordings.append('down', 'b')

    assert recordings.delete_last() is True

    lines = (tmp_path / 'recordings.jsonl').read_text().splitlines()
    assert len(lines) == 1
    assert json.loads(lines[0])['gesture'] == 'up'


def test_delete_last_on_a_missing_file_returns_false(tmp_path):
    recordings = Recordings(tmp_path / 'recordings.jsonl')

    assert recordings.delete_last() is False


def test_delete_last_on_an_empty_file_returns_false(tmp_path):
    path = tmp_path / 'recordings.jsonl'
    path.write_text('')

    assert Recordings(path).delete_last() is False


def test_append_then_delete_is_a_round_trip(tmp_path):
    recordings = Recordings(tmp_path / 'recordings.jsonl')
    recordings.append('up', 'a')
    recordings.delete_last()

    assert (tmp_path / 'recordings.jsonl').read_text() == ''
