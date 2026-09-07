import ipaddress
from dataclasses import dataclass

import ifaddr


@dataclass(frozen=True)
class LanInterface:
    source_ip: str
    broadcast_ip: str


class LanInterfaceNotFound(Exception):
    pass


def select_lan_interface(addresses, lan_cidr):
    network = ipaddress.ip_network(lan_cidr, strict=False)

    for address in addresses:
        if ipaddress.ip_interface(address).ip in network:
            return LanInterface(
                source_ip=str(ipaddress.ip_interface(address).ip),
                broadcast_ip=str(network.broadcast_address),
            )

    raise LanInterfaceNotFound(
        f'no interface address within {lan_cidr}; saw {addresses}'
    )


def local_addresses():
    return [
        f'{ip.ip}/{ip.network_prefix}'
        for adapter in ifaddr.get_adapters()
        for ip in adapter.ips
        if ip.is_IPv4
    ]
