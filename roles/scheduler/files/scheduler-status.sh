#!/bin/bash
set -Eeuo pipefail

if [[ -t 1 ]] && tput colors &>/dev/null && [[ "$(tput colors)" -ge 8 ]]; then
    GREEN='\e[32m'
    RED='\e[31m'
    RESET='\e[0m'
else
    GREEN=''
    RED=''
    RESET=''
fi

mapfile -t service_ids < <(docker service ls --format json | jq -r '.ID')
if [[ "${#service_ids[@]}" -eq 0 ]]; then
    echo "No services"
    exit 0
fi

services_json="$(
    jq -n \
        --slurpfile ls <(docker service ls --format json | jq -s '.') \
        --slurpfile inspect <(docker service inspect "${service_ids[@]}") \
        --slurpfile ps <(docker service ps --format json "${service_ids[@]}" | jq -s '.') \
        '
            def padStart(n; c): tostring | (n - length) * c + .;
            def timeago($now):
                if . == "-" then "-"
                else
                    (sub("Z$"; "") | strptime("%Y-%m-%dT%H:%M:%S") | mktime) as $ts
                    | ([($now - $ts), 0] | max | floor) as $diff
                    | "\($diff / 86400 | floor)d \($diff % 86400 / 3600 | floor | padStart(2; " "))h \($diff % 3600 / 60 | floor | padStart(2; " "))m"
                end;

            now as $now
            | ($ls[0] | map({key: .Name, value: .}) | from_entries) as $ls_by_name
            | (
                $ps[0]
                | map(select(.CurrentState | startswith("Running")))
                | map({service: (.Name | sub("\\.[0-9]+$"; "")), node: .Node})
                | group_by(.service)
                | map({key: .[0].service, value: (map(.node) | unique | join(", "))})
                | from_entries
            ) as $nodes_by_name
            | $inspect[0]
            | map(
                (.Spec.Name) as $name
                | ($ls_by_name[$name].Replicas // "") as $replicas_state
                | ($replicas_state | capture("^(?<running>[0-9]+)/(?<desired>[0-9]+)$")?) as $state
                | (.Spec.Labels["home.scheduler.priority"]) as $priority_raw
                | (.Spec.Labels["home.scheduler.replicas"]) as $replicas_raw
                | (.Spec.Labels["home.scheduler.restart"] // "") as $restart_raw
                | (try ($priority_raw | tonumber) catch null) as $priority_num
                | (try ($replicas_raw | tonumber) catch null) as $replicas_num
                | ((.UpdatedAt // "-") | sub("\\.[0-9]+Z$"; "Z")) as $updated_at
                | {
                    name: $name,
                    running: ($state.running // "-"),
                    desired: ($state.desired // "-"),
                    updated_at: $updated_at,
                    relative: ($updated_at | timeago($now)),
                    priority_display: (if $priority_num == null then "-" else ($priority_num | tostring) end),
                    replicas_display: (if $replicas_num == null then "-" else ($replicas_num | tostring) end),
                    restart_display: (if $restart_raw == "true" then "yes" else "-" end),
                    nodes: ($nodes_by_name[$name] // "-"),
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

total_running=$(echo "${services_json}" | jq '[.[] | select(.running != "-") | .running | tonumber] | add // 0')
total_replicas=$(echo "${services_json}" | jq '[.[] | select(.replicas_display != "-") | .replicas_display | tonumber] | add // 0')

if [[ "${total_running}" -eq "${total_replicas}" ]]; then
    printf "${GREEN}● running${RESET} (%s/%s)\n" "${total_running}" "${total_replicas}"
else
    printf "${RED}● degraded${RESET} (%s/%s)\n" "${total_running}" "${total_replicas}"
fi
echo ""

printf '%-8s %-40s %-8s %-8s %-8s %-8s %-22s %-12s %s\n' "PRIORITY" "SERVICE" "RUNNING" "DESIRED" "REPLICAS" "RESTART" "UPDATED" "RELATIVE" "NODES"
echo "${services_json}" \
    | jq -r '.[] | [.priority_display, .name, .running, .desired, .replicas_display, .restart_display, .updated_at, .relative, .nodes] | @tsv' \
    | while IFS=$'\t' read -r priority name running desired replicas restart updated relative nodes; do
        printf '%-8s %-40s %-8s %-8s %-8s %-8s %-22s %-12s %s\n' "${priority}" "${name}" "${running}" "${desired}" "${replicas}" "${restart}" "${updated}" "${relative}" "${nodes}"
    done
