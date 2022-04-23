FROM pihole/pihole:2022.04.3@sha256:c1ac62e8ec922bca85df4bb8082bc4c4b8aa776d25ee11c341e8f6a531621aa4

ADD build/adlists.list /etc/pihole/

RUN rm -rf /etc/pihole/migration_backup && pihole -g -r recreate
