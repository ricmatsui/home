import json
from pathlib import Path


def test_gestures_json_is_loadable_and_ordered():
    gestures = json.loads(
        (Path(__file__).parent.parent / 'static' / 'gestures.json').read_text()
    )

    assert [gesture['name'] for gesture in gestures] == [
        'up',
        'down',
        'left',
        'right',
        'circle',
        'counterCircle',
        'n',
        'p',
        'v',
        '^',
    ]
    assert all('action' in gesture for gesture in gestures)
