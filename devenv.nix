{ pkgs, lib, config, inputs, ... }:

{
  # Empty scaffold. Per-image build needs (e.g. uv, node) get added here
  # as images appear. Docker, buildx, and git come from the host.
  packages = [ ];
}
