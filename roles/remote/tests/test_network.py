import pytest

from app.network import (
    LanInterface,
    LanInterfaceNotFound,
    select_lan_interface,
)


def test_selects_the_address_inside_the_lan_cidr():
    result = select_lan_interface(['10.0.1.42/24'], '10.0.1.0/24')

    assert result == LanInterface(source_ip='10.0.1.42', broadcast_ip='10.0.1.255')


def test_ignores_the_overlay_address_and_picks_the_lan_one():
    result = select_lan_interface(
        ['127.0.0.1/8', '10.0.9.3/24', '172.18.0.5/16', '10.0.1.42/24'],
        '10.0.1.0/24',
    )

    assert result.source_ip == '10.0.1.42'


def test_derives_the_broadcast_from_the_configured_cidr_not_the_address():
    result = select_lan_interface(['192.168.4.7/32'], '192.168.4.0/22')

    assert result.broadcast_ip == '192.168.7.255'


def test_raises_when_no_address_is_on_the_lan():
    with pytest.raises(LanInterfaceNotFound) as error:
        select_lan_interface(['172.18.0.5/16'], '10.0.1.0/24')

    assert '10.0.1.0/24' in str(error.value)
    assert '172.18.0.5/16' in str(error.value)


def test_raises_when_there_are_no_addresses_at_all():
    with pytest.raises(LanInterfaceNotFound):
        select_lan_interface([], '10.0.1.0/24')
