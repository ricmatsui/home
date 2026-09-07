import argparse
import shutil
from pathlib import Path

from huggingface_hub import HfApi

ROOT = Path(__file__).parent
REPO_ID = 'ricmatsui/remote-gesture'


def stage(out, cards, gestures):
    staging = out / 'upload'

    if staging.exists():
        shutil.rmtree(staging)

    staging.mkdir(parents=True)

    shutil.copytree(out / 'tfjs', staging / 'tfjs')
    shutil.copy(out / 'model.keras', staging / 'model.keras')
    shutil.copy(gestures, staging / 'gestures.json')
    shutil.copy(cards / 'model_card.md', staging / 'README.md')

    return staging


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path, default=ROOT / 'out')
    parser.add_argument('--repo-id', default=REPO_ID)
    parser.add_argument('--message', default='Update the gesture model')
    arguments = parser.parse_args()

    staging = stage(arguments.out, ROOT / 'cards', ROOT.parent / 'static' / 'gestures.json')

    api = HfApi()
    api.create_repo(arguments.repo_id, exist_ok=True, private=False)

    commit = api.upload_folder(
        folder_path=staging,
        repo_id=arguments.repo_id,
        commit_message=arguments.message,
        delete_patterns='*',
    )

    print()
    print('published:', f'https://huggingface.co/{arguments.repo_id}')
    print('revision: ', commit.oid)


if __name__ == '__main__':
    main()
