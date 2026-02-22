#!/bin/bash
set -Eeuo pipefail

if ! docker node ls --format json 2>/dev/null \
    | jq -r 'select(.Self == true) | .ManagerStatus' \
    | grep -qx 'Leader'; then
    echo "Not leader"
    exit 0
fi

echo "Leader"

mapfile -t service_ids < <(docker service ls --format json | jq -r '.ID')
if [[ "${#service_ids[@]}" -eq 0 ]]; then
    echo "No services"
    exit 0
fi

restart_services_json="$(
    docker service inspect "${service_ids[@]}" \
    | jq '
        map(
            select((.Spec.Labels["home.scheduler.restart"] // "") == "true")
            | (.Spec.Labels["home.scheduler.priority"]) as $priority_raw
            | (try ($priority_raw | tonumber) catch null) as $priority_num
            | {
                name: .Spec.Name,
                priority: ($priority_num // 0),
            }
        )
        | sort_by(.priority, .name)
    '
)"

if [[ "$(echo "${restart_services_json}" | jq 'length')" -eq 0 ]]; then
    echo "No restart services found"
    exit 0
fi

mapfile -t restart_service_names < <(echo "${restart_services_json}" | jq -r '.[].name')
restart_service_count="${#restart_service_names[@]}"

for index in "${!restart_service_names[@]}"; do
    name="${restart_service_names[${index}]}"
    number="$((index + 1))"
    echo "Restarting ${name} (${number}/${restart_service_count})"
    docker service update --quiet --force "${name}"
    echo "Sleeping for 300 seconds"
    sleep 300
done
