import argparse
import base64
import io
import json
from pathlib import Path

from datasets import ClassLabel, Dataset, Features, Image as ImageFeature
from huggingface_hub import HfApi
from PIL import Image

ROOT = Path(__file__).parent
REPO_ID = 'ricmatsui/remote-gesture'
TEST_SIZE = 0.2
SEED = 0


def load_gesture_names(path):
    return [gesture['name'] for gesture in json.loads(Path(path).read_text())]


def build_dataset(recordings_path, gesture_names):
    images = []
    labels = []

    for line in Path(recordings_path).read_text().splitlines():
        line = line.strip()

        if not line:
            continue

        row = json.loads(line)

        if row['gesture'] not in gesture_names:
            raise ValueError(
                f"unknown gesture {row['gesture']!r}; "
                f'known gestures are {gesture_names}'
            )

        images.append(
            Image.open(
                io.BytesIO(base64.b64decode(row['image'].split(',', 1)[1]))
            ).convert('L')
        )
        labels.append(gesture_names.index(row['gesture']))

    return Dataset.from_dict(
        {'image': images, 'label': labels},
        features=Features({
            'image': ImageFeature(),
            'label': ClassLabel(names=gesture_names),
        }),
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--recordings', default=ROOT / 'recordings.jsonl')
    parser.add_argument('--gestures', default=ROOT.parent / 'static' / 'gestures.json')
    parser.add_argument('--repo-id', default=REPO_ID)
    parser.add_argument('--test-size', type=float, default=TEST_SIZE)
    parser.add_argument('--seed', type=int, default=SEED)
    parser.add_argument('--dry-run', action='store_true')
    arguments = parser.parse_args()

    gesture_names = load_gesture_names(arguments.gestures)
    dataset = build_dataset(arguments.recordings, gesture_names)

    print(f'{len(dataset)} samples')
    for index, name in enumerate(gesture_names):
        count = sum(1 for label in dataset['label'] if label == index)
        print(f'  {name:>15}  {count}')

    splits = dataset.train_test_split(
        test_size=arguments.test_size,
        stratify_by_column='label',
        seed=arguments.seed,
    )

    print(f"{len(splits['train'])} train, {len(splits['test'])} test")

    if arguments.dry_run:
        return

    splits.push_to_hub(arguments.repo_id, private=False)

    print(f'https://huggingface.co/datasets/{arguments.repo_id}')


if __name__ == '__main__':
    main()
