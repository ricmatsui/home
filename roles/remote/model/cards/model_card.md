---
license: mit
library_name: keras
pipeline_tag: image-classification
tags:
  - tensorflowjs
  - gesture-recognition
datasets:
  - ricmatsui/remote-gesture
metrics:
  - accuracy
---

# Remote Gesture

A small convolutional classifier that turns a single-stroke touch gesture into
one of ten television remote actions. It runs in the browser via TensorFlow.js
on the phone that drew the gesture; no inference happens server-side.

## Files

| file | purpose |
|---|---|
| `model.keras` | the trained Keras model |
| `tfjs/model.json`, `tfjs/group1-shard1of1.bin` | TensorFlow.js conversion, what the app loads |
| `gestures.json` | label order and the action each class maps to |

## Input

A 32×32 single-channel image scaled to `[0, 1]`, produced by the rasterisation
described in the [dataset card](https://huggingface.co/datasets/ricmatsui/remote-gesture).
The greyscale ramp along the stroke encodes direction, so **stroke order is
part of the input**, not just shape.

## Architecture

```
Input(32, 32, 1)
Conv2D(32, 3, relu, padding=same) -> MaxPool2D(2)
Conv2D(64, 3, relu, padding=same) -> MaxPool2D(2)
Flatten -> Dense(128, relu) -> Dropout(0.4) -> Dense(10, softmax)
```

## Training

- Optimiser: legacy Adam, `clipnorm=1.0`
- Learning rate: `CosineDecayRestarts(1e-4, first_decay_steps=50, t_mul=2.0, m_mul=0.9, alpha=1e-7)`
- Loss: sparse categorical cross-entropy
- Batch size 32, up to 500 epochs
- `EarlyStopping(monitor='val_loss', patience=30, restore_best_weights=True, min_delta=1e-4)`
- Trained on the dataset's `train` split and validated on `test`; augmentation touches only `train`, so validation is un-augmented real data
- Each training class is oversampled to 10,000 with `RandomZoom((-0.1, 0.3))`,
  `RandomRotation(0.02)`, and `RandomTranslation(0.1, 0.1)`, plus per-class
  flips and rotations gated by the `allowMirrorHorizontal`,
  `allowMirrorVertical`, `allowRotation`, and `allowSlanted` flags in
  `gestures.json`

## Intended use

The application **rejects any prediction below 0.6 confidence** and treats it as
"unknown" — it vibrates three times and sends nothing. That threshold is part
of how the model is used and should be carried over by anyone reusing it; the
model has no reject class of its own.

## Limitations

- One author's handwriting, one device, one screen geometry.
- Sensitive to stroke direction by design.
- Ten fixed classes; adding one requires retraining and republishing both the
  dataset and the model.
