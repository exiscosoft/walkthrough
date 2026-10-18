#!/usr/bin/env bash
# Create speech/.venvs/<extra> with the base package plus one engine extra.
set -euo pipefail
cd "$(dirname "$0")"
extra="${1:?usage: setup.sh chatterbox|f5|mlxaudio|align}"
uv venv ".venvs/$extra" --python 3.11 --allow-existing
uv pip install --python ".venvs/$extra/bin/python" -e ".[$extra]"
echo ".venvs/$extra/bin/python"
