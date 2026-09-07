import base64
import io
import json

import pytest
from PIL import Image

from publish_dataset import build_dataset, load_gesture_names

GESTURE_NAMES = ['up', 'down', 'circle']


def encoded_image(shade=128):
    image = Image.new('L', (32, 32), shade)
    buffer = io.BytesIO()
    image.save(buffer, format='PNG')
    return 'data:image/png;base64,' + base64.b64encode(
        buffer.getvalue()
    ).decode('utf-8')


def write_recordings(path, rows):
    path.write_text(
        ''.join(json.dumps(row) + '\n' for row in rows)
    )


def test_load_gesture_names_preserves_file_order(tmp_path):
    path = tmp_path / 'gestures.json'
    path.write_text(json.dumps([
        {'name': 'up', 'action': 'up'},
        {'name': 'down', 'action': 'down'},
    ]))

    assert load_gesture_names(path) == ['up', 'down']


def test_build_dataset_round_trips_label_and_image(tmp_path):
    path = tmp_path / 'recordings.jsonl'
    write_recordings(path, [{'gesture': 'circle', 'image': encoded_image()}])

    dataset = build_dataset(path, GESTURE_NAMES)

    assert len(dataset) == 1
    assert dataset.features['label'].names == GESTURE_NAMES
    assert dataset[0]['label'] == GESTURE_NAMES.index('circle')
    assert dataset[0]['image'].size == (32, 32)
    assert dataset[0]['image'].mode == 'L'


def test_build_dataset_rejects_an_unknown_gesture(tmp_path):
    path = tmp_path / 'recordings.jsonl'
    write_recordings(path, [{'gesture': 'spiral', 'image': encoded_image()}])

    with pytest.raises(ValueError) as error:
        build_dataset(path, GESTURE_NAMES)

    assert 'spiral' in str(error.value)


def test_build_dataset_skips_blank_lines(tmp_path):
    path = tmp_path / 'recordings.jsonl'
    path.write_text(
        json.dumps({'gesture': 'up', 'image': encoded_image()}) + '\n\n\n'
    )

    assert len(build_dataset(path, GESTURE_NAMES)) == 1
