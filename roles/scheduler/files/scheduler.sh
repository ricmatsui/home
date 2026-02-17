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

managed_services_json="$(
    jq -n \
    --slurpfile ls <(docker service ls --format json | jq -s '.') \
    --slurpfile inspect <(docker service inspect "${service_ids[@]}") \
    '
        ($ls[0] | map({key: .Name, value: .}) | from_entries) as $ls_by_name
        | $inspect[0]
        | map(
            select(.Spec.Labels["home.scheduler.priority"] != null)
            | (.Spec.Name) as $name
            | ($ls_by_name[$name].Replicas // "0/0" | split("/")) as $state
            | (.UpdatedAt | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) as $updated_at
            | {
                name: $name,
                priority: (.Spec.Labels["home.scheduler.priority"] | tonumber),
                replicas: (.Spec.Labels["home.scheduler.replicas"] | tonumber),
                desired: (.Spec.Mode.Replicated.Replicas // 0),
                running: ($state[0] | tonumber),
                updated_at: $updated_at,
                is_stable: ($updated_at <= (now - 3600)),
            }
        )
    '
)"

if [[ "$(echo "${managed_services_json}" | jq 'length')" -eq 0 ]]; then
    echo "No managed services found"
    exit 0
fi

target_service_json="$(
    echo "${managed_services_json}" \
    | jq -c '
        sort_by(.priority, .name)
        | map(select(.is_stable and .running < .replicas))
        | .[0] // empty
    '
)"

if [[ -z "${target_service_json}" ]]; then
    echo "No target service found"
    exit 0
fi

target_name="$(echo "${target_service_json}" | jq -r '.name')"
target_desired="$(echo "${target_service_json}" | jq -r '.desired')"
target_replicas="$(echo "${target_service_json}" | jq -r '.replicas')"
target_priority="$(echo "${target_service_json}" | jq -r '.priority')"

echo "Target service: ${target_name}"

if [[ "${target_desired}" -lt "${target_replicas}" ]]; then
    target_new_desired="$((target_desired + 1))"
    echo "Scaling target up: ${target_desired} -> ${target_new_desired}"
    docker service scale -d "${target_name}=${target_new_desired}"
    exit 0
fi

echo "Finding donor service"

donor_service_json="$(
    echo "${managed_services_json}" \
    | jq -c \
        --arg target_name "${target_name}" \
        --argjson target_priority "${target_priority}" \
        '
            sort_by(.priority, .name)
            | reverse
            | map(select(
                .name != $target_name
                and .is_stable
                and .desired > 0
                and (
                    .priority > $target_priority
                    or (.priority == $target_priority and .name > $target_name)
                )
            ))
            | .[0] // empty
        '
)"

if [[ -z "${donor_service_json}" ]]; then
    echo "No donor service found"
    exit 0
fi

donor_name="$(echo "${donor_service_json}" | jq -r '.name')"
donor_desired="$(echo "${donor_service_json}" | jq -r '.desired')"
donor_new_desired="$((donor_desired - 1))"

echo "Donor service: ${donor_name}"
echo "Scaling donor down: ${donor_desired} -> ${donor_new_desired}"
docker service scale -d "${donor_name}=${donor_new_desired}"
