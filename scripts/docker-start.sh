#!/usr/bin/env bash

set -euo pipefail

compose=(docker compose --env-file .env -f docker/compose.yaml)
docker_config_dir=${DOCKER_CONFIG:-"${HOME}/.docker"}
user_buildx_plugin="${docker_config_dir}/cli-plugins/docker-buildx"
use_classic_builder=false

if [[ -L "${user_buildx_plugin}" && ! -e "${user_buildx_plugin}" ]]; then
  printf '%s\n' \
    'The configured Buildx plugin is broken; building the API with the classic Docker builder.' >&2
  use_classic_builder=true
elif ! docker buildx version >/dev/null 2>&1; then
  printf '%s\n' \
    'Buildx is unavailable; building the API with the classic Docker builder.' >&2
  use_classic_builder=true
elif ! "${compose[@]}" build api; then
  printf '%s\n' \
    'The Buildx build failed; retrying the API build with the classic Docker builder.' >&2
  use_classic_builder=true
fi

if [[ "${use_classic_builder}" == true ]]; then
  COMPOSE_DOCKER_CLI_BUILD=0 DOCKER_BUILDKIT=0 "${compose[@]}" build api
fi

"${compose[@]}" up -d --wait
