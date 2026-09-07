import datetime
import json
from pathlib import Path

import numpy as np
import tensorflow as tf
import tensorflowjs as tfjs
from datasets import load_dataset

ROOT = Path(__file__).parent
DATASET_ID = 'ricmatsui/remote-gesture'


def assert_label_order(dataset_names, gestures):
    expected = [gesture['name'] for gesture in gestures]

    if list(dataset_names) != expected:
        raise ValueError(
            'dataset label order does not match gestures.json.\n'
            f'  dataset:       {list(dataset_names)}\n'
            f'  gestures.json: {expected}\n'
            'Training would produce a model whose outputs are permuted.'
        )


def to_tensors(split, gestures):
    images = np.stack([
        np.array(image.convert('L'), dtype=np.float32) / 255.0
        for image in split['image']
    ])

    return dict(
        gestures=gestures,
        image_tensor=images[..., np.newaxis],
        gesture_index_tensor=np.array(split['label']),
    )


def load_data():
    gestures = json.loads((ROOT.parent / 'static' / 'gestures.json').read_text())

    dataset = load_dataset(DATASET_ID)

    assert_label_order(dataset['train'].features['label'].names, gestures)

    return (
        to_tensors(dataset['train'], gestures),
        to_tensors(dataset['test'], gestures),
    )

def augment(data):
    class_counts = np.bincount(data['gesture_index_tensor'], minlength=len(data['gestures']))
    target = 10000

    image_tensors = [data['image_tensor']]
    gesture_index_tensors = [data['gesture_index_tensor']]

    for index in range(len(data['gestures'])):
        needed = target - class_counts[index]

        if needed <= 0:
            continue

        repetitions = (needed // class_counts[index]) + 1

        source = np.tile(
                data['image_tensor'][data['gesture_index_tensor'] == index],
                (repetitions, 1, 1, 1),
        )[:needed]

        additional = []

        if data['gestures'][index].get('allowMirrorHorizontal', False):
            additional.append(tf.keras.layers.RandomFlip(mode='horizontal'))

        if data['gestures'][index].get('allowMirrorVertical', False):
            additional.append(tf.keras.layers.RandomFlip(mode='vertical'))

        if data['gestures'][index].get('allowRotation', False):
            additional.append(tf.keras.layers.RandomRotation(1.0, fill_mode='constant', fill_value=0.0))

        if data['gestures'][index].get('allowSlanted', False):
            additional.append(tf.keras.layers.RandomRotation(0.06, fill_mode='constant', fill_value=0.0))

        augmentation = tf.keras.Sequential([
            *additional,
            tf.keras.layers.RandomZoom((-0.1, 0.3), fill_mode='constant', fill_value=0.0),
            tf.keras.layers.RandomRotation(0.02, fill_mode='constant', fill_value=0.0),
            tf.keras.layers.RandomTranslation(0.1, 0.1, fill_mode='constant', fill_value=0.0),
        ])

        augmented_images = np.clip(
            augmentation(source, training=True).numpy(),
            0.0,
            1.0,
        )

        image_tensors.append(augmented_images)
        gesture_index_tensors.append(np.full(len(augmented_images), index, dtype=np.int32))

    return dict(
        gestures=data['gestures'],
        image_tensor=np.concatenate(image_tensors),
        gesture_index_tensor=np.concatenate(gesture_index_tensors),
    )

def build_model(classes_count):
    return tf.keras.Sequential([
        tf.keras.layers.Input(shape=(32, 32, 1)),
        tf.keras.layers.Conv2D(32, 3, activation='relu', padding='same'),
        tf.keras.layers.MaxPool2D(2),
        tf.keras.layers.Conv2D(64, 3, activation='relu', padding='same'),
        tf.keras.layers.MaxPool2D(2),
        tf.keras.layers.Flatten(),
        tf.keras.layers.Dense(128, activation='relu'),
        tf.keras.layers.Dropout(0.4),
        tf.keras.layers.Dense(classes_count, activation='softmax'),
    ])

def train_model(model, train_data, validation_data):
    lr_schedule = tf.keras.optimizers.schedules.CosineDecayRestarts(
        initial_learning_rate=1e-4,
        first_decay_steps=50,
        t_mul=2.0,
        m_mul=0.9,
        alpha=1e-7,
    )

    model.compile(
        optimizer=tf.keras.optimizers.legacy.Adam(
            learning_rate=lr_schedule,
            clipnorm=1.0,
        ),
        loss='sparse_categorical_crossentropy',
        metrics=['accuracy'],
    )

    log_dir = "logs/fit/" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    tensorboard_callback = tf.keras.callbacks.TensorBoard(log_dir=log_dir, histogram_freq=1)

    model.fit(
        train_data['image_tensor'],
        train_data['gesture_index_tensor'],
        epochs=500,
        batch_size=32,
        shuffle=True,
        validation_data=(
            validation_data['image_tensor'],
            validation_data['gesture_index_tensor'],
        ),
        callbacks=[
            tensorboard_callback,
            tf.keras.callbacks.EarlyStopping(
                monitor='val_loss',
                patience=30,
                restore_best_weights=True,
                min_delta=1e-4,
            ),
            tf.keras.callbacks.ModelCheckpoint(
                filepath=log_dir + '/best_model.keras',
                monitor='val_loss',
                save_best_only=True,
                verbose=0,
            ),
        ],
        verbose=1,
    )


def main():
    train_data, validation_data = load_data()

    print("Train class distribution:", np.bincount(train_data['gesture_index_tensor']))
    print("Val class distribution:  ", np.bincount(validation_data['gesture_index_tensor']))

    train_data = augment(train_data)

    logdir = "logs/data/" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    file_writer = tf.summary.create_file_writer(logdir)

    with file_writer.as_default():
        indices = tf.random.shuffle(tf.range(tf.shape(train_data['image_tensor'])[0]))[:100]
        sampled = tf.gather(train_data['image_tensor'], indices)
        tf.summary.image("input images", sampled, step=0, max_outputs=100)

    model = build_model(classes_count=len(train_data['gestures']))
    model.summary()

    print("GPU devices:", tf.config.list_physical_devices('GPU'))

    train_model(model, train_data, validation_data)
    out = ROOT / 'out'
    out.mkdir(exist_ok=True)
    model.save(out / 'model.keras')
    tfjs.converters.save_keras_model(model, str(out / 'tfjs'))
    print(f'wrote {out}')


if __name__ == '__main__':
    main()
