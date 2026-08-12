#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
desktop_workflow="${repo_root}/.github/workflows/desktop.yml"
release_workflow="${repo_root}/.github/workflows/release-please.yml"
turbo_workflow="${repo_root}/.github/workflows/turbo.yml"

if grep -q '^  deploy-desktop:' "$turbo_workflow"; then
  echo "deploy-desktop must remain outside turbo.yml" >&2
  exit 1
fi

ruby -e '
  require "yaml"

  desktop = YAML.safe_load(File.read(ARGV[0]), aliases: true).fetch("jobs")
  release = YAML.safe_load(File.read(ARGV[1]), aliases: true).fetch("jobs")

  detector = desktop.fetch("detect-desktop-version")
  build = desktop.fetch("build-macos")
  deploy = desktop.fetch("deploy-desktop")
  raise "deploy-desktop must depend on version detection" unless deploy.fetch("needs") == "detect-desktop-version"
  raise "deploy-desktop must not use a GitHub environment" if deploy.key?("environment")
  raise "deploy-desktop must use the version detector output" unless deploy.fetch("if").include?(ARGV[2])
  raise "deploy-desktop must only publish merge-group commits" unless deploy.fetch("if").include?(ARGV[3])

  detector_run = detector.fetch("steps").find { |step| step["id"] == "version" }.fetch("run")
  raise "version detector must compare Desktop package versions" unless detector_run.include?("resolve-desktop-version-change.sh")

  okou_build = build.fetch("steps").find { |step| step["id"] == "build-okou-prod" }
  raise "Desktop CI must build the Okou product" unless okou_build
  raise "Okou CI build must select the Okou product" unless okou_build.fetch("env").fetch("VM0_DESKTOP_PRODUCT") == "okou"
  raise "Okou CI build must use app.okou.ai" unless okou_build.fetch("env").fetch("VM0_DESKTOP_PLATFORM_URL") == "https://app.okou.ai"
  raise "Okou CI build must package runtime product identity" unless okou_build.fetch("run").include?("product: process.env.VM0_DESKTOP_PRODUCT")

  okou_verify = build.fetch("steps").find { |step| step["name"] == "Verify Okou production artifact" }.fetch("run")
  raise "Okou artifact must verify its bundle ID" unless okou_verify.include?("ai.okou.desktop")
  raise "Okou artifact must verify side-by-side installation" unless okou_verify.include?("Zero and Okou should remain installable side by side")

  artifact_step = deploy.fetch("steps").find { |step| step["id"] == "artifact" }
  raise "deploy-desktop must resolve the checked-out commit" unless artifact_step.fetch("run").include?("resolve-build-commit-sha.sh")
  raise "deploy-desktop must use a SHA-addressed R2 prefix" unless artifact_step.fetch("run").include?(ARGV[6])

  build_step = deploy.fetch("steps").find { |step| step["name"] == "Build canonical unsigned Desktop app" }
  raise "canonical Desktop build must skip signing" unless build_step.fetch("env").fetch("VM0_DESKTOP_SKIP_SIGNING") == "true"
  raise "canonical Desktop build must package Okou" unless build_step.fetch("run").include?("Okou.app")
  raise "canonical Okou build must target app.okou.ai" unless build_step.fetch("run").include?("VM0_DESKTOP_PLATFORM_URL=https://app.okou.ai")

  artifact_build = deploy.fetch("steps").find { |step| step["name"] == "Create canonical Desktop artifact" }.fetch("run")
  raise "canonical artifact must contain the Okou app" unless artifact_build.include?("Okou-darwin-arm64/Okou.app")

  artifact_upload = deploy.fetch("steps").find { |step| step["name"] == "Upload canonical Desktop artifact" }.fetch("run")
  raise "canonical artifact must upload the Okou archive" unless artifact_upload.include?("okou-app.tar.gz")

  promote = release.fetch("promote-desktop-release")
  raise "Desktop promotion must use production environment" unless promote.fetch("environment") == "production"
  checkout = promote.fetch("steps").find { |step| step["uses"].to_s.start_with?("actions/checkout@") }
  raise "Desktop promotion must check out release_target" unless checkout.fetch("with").fetch("ref") == ARGV[4]

  download = promote.fetch("steps").find { |step| step["id"] == "desktop-app" }.fetch("run")
  raise "Desktop promotion must fetch the canonical R2 artifact" unless download.include?("fetch-okou-desktop-artifact.sh")
  raise "Desktop promotion must verify the canonical R2 artifact" unless download.include?("verify-okou-desktop-artifact.sh")
  raise "Desktop promotion must address artifacts by release_target" unless download.include?(ARGV[5])
  raise "Desktop promotion must require the Okou app archive" unless download.include?("--require-okou")

  promote_text = File.read(ARGV[1]).split("  promote-desktop-release:\n", 2).fetch(1).split(/\n  [a-zA-Z0-9_-]+:\n/, 2).first
  raise "Desktop promotion must not rebuild the app" if promote_text.include?("pnpm -F @vm0/desktop build")
  raise "Desktop promotion must sign the downloaded app" unless promote_text.include?("sign-and-notarize-packaged-app.mjs")
  raise "Desktop promotion must select a product signing identity" unless promote_text.include?("--product")
  raise "Desktop promotion must publish an independent Okou release" unless promote_text.include?("OKOU_RELEASE_TAG: okou-desktop-v")
  raise "Desktop promotion must publish Okou artifacts" unless promote_text.include?("Okou-darwin-arm64-")
  raise "Desktop promotion must smoke-test Okou installation" unless promote_text.include?("okou-install-smoke")
  raise "Desktop promotion must smoke-test Okou updates" unless promote_text.include?("okou-update-smoke")

  publish = release.fetch("publish-desktop-update-manifest")
  raise "Desktop manifest must wait for promotion" unless Array(publish.fetch("needs")).include?("promote-desktop-release")
  publish_text = publish.fetch("steps").find { |step| step["name"] == "Publish Desktop update manifest" }.fetch("run")
  raise "Desktop manifests must preserve the Zero feed" unless publish_text.include?("desktop-update-manifest.json")
  raise "Desktop manifests must publish the Okou feed" unless publish_text.include?("ai-okou-desktop-update-manifest.json")
  raise "Desktop manifests must publish under the Okou mutable tag" unless publish_text.include?("ai-okou-desktop-updates")
' \
  "$desktop_workflow" \
  "$release_workflow" \
  "needs.detect-desktop-version.outputs.changed == 'true'" \
  "github.event_name == 'merge_group'" \
  "\${{ needs.release-please.outputs.release_target }}" \
  "okou-desktop/\${ARTIFACT_SHA}" \
  "okou-desktop/\$sha"

grep -q '^  merge_group:' "$desktop_workflow"

echo "deploy-desktop workflow tests passed"
