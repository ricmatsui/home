#!/bin/bash
set -Eeuo pipefail

mapfile -t service_ids < <(docker service ls --format json | jq -r '.ID')
if [[ "${#service_ids[@]}" -eq 0 ]]; then
    echo "No services"
    exit 0
fi

services_json="$(
    jq -n \
        --slurpfile ls <(docker service ls --format json | jq -s '.') \
        --slurpfile inspect <(docker service inspect "${service_ids[@]}") \
        '
            ($ls[0] | map({key: .Name, value: .}) | from_entries) as $ls_by_name
            | $inspect[0]
            | map(
                (.Spec.Name) as $name
                | ($ls_by_name[$name].Replicas // "") as $replicas_state
                | ($replicas_state | capture("^(?<running>[0-9]+)/(?<desired>[0-9]+)$")?) as $state
                | (.Spec.Labels["home.scheduler.priority"]) as $priority_raw
                | (.Spec.Labels["home.scheduler.replicas"]) as $replicas_raw
                | (try ($priority_raw | tonumber) catch null) as $priority_num
                | (try ($replicas_raw | tonumber) catch null) as $replicas_num
                | {
                    name: $name,
                    running: ($state.running // "-"),
                    desired: ($state.desired // "-"),
                    updated_at: ((.UpdatedAt // "-") | sub("\\.[0-9]+Z$"; "Z")),
                    priority_display: (if $priority_num == null then "-" else ($priority_num | tostring) end),
                    replicas_display: (if $replicas_num == null then "-" else ($replicas_num | tostring) end),
                    unlabeled_first: (if $priority_num == null then 0 else 1 end),
                    priority_sort: ($priority_num // 0),
                }
            )
            | sort_by(.unlabeled_first, .priority_sort, .name)
        '
)"

if [[ "$(echo "${services_json}" | jq 'length')" -eq 0 ]]; then
    echo "No services"
    exit 0
fi

printf '%-8s %-40s %-8s %-8s %-8s %-30s\n' "PRIORITY" "SERVICE" "RUNNING" "DESIRED" "REPLICAS" "UPDATED"
echo "${services_json}" \
    | jq -r '.[] | [.priority_display, .name, .running, .desired, .replicas_display, .updated_at] | @tsv' \
    | while IFS=$'\t' read -r priority name running desired replicas updated; do
        printf '%-8s %-40s %-8s %-8s %-8s %-30s\n' "${priority}" "${name}" "${running}" "${desired}" "${replicas}" "${updated}"
    done
