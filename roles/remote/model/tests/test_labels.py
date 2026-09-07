import pytest

from train import assert_label_order

GESTURES = [
    {'name': 'up', 'action': 'up'},
    {'name': 'down', 'action': 'down'},
    {'name': 'circle', 'action': 'powerOn'},
]


def test_matching_order_is_accepted():
    assert_label_order(['up', 'down', 'circle'], GESTURES)


def test_permuted_order_is_rejected():
    with pytest.raises(ValueError) as error:
        assert_label_order(['down', 'up', 'circle'], GESTURES)

    assert 'order' in str(error.value).lower()


def test_missing_label_is_rejected():
    with pytest.raises(ValueError):
        assert_label_order(['up', 'down'], GESTURES)


def test_extra_label_is_rejected():
    with pytest.raises(ValueError):
        assert_label_order(['up', 'down', 'circle', 'spiral'], GESTURES)
