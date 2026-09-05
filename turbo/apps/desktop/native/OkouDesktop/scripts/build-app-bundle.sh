#!/usr/bin/env bash
#
# Assembles the native Swift Okou.app bundle without an Xcode project.
#
# Usage: build-app-bundle.sh --out <dir> [--product okou|zero] [--platform-url URL]
#        [--configuration release|debug] [--signing-identity ID]
#
# Builds the okou-desktop executable and both native helpers with SwiftPM,
# lays out <DisplayName>.app with the same identity table, icons, URL scheme
# and runtime config as the Electron packager, ad-hoc signs it, and writes a
# zip beside the bundle.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
package_root="$(cd "$script_dir/.." && pwd)"
desktop_root="$(cd "$package_root/../.." && pwd)"
helper_root="$desktop_root/native/computer-use-helper"

out_dir=""
product="${OKOU_DESKTOP_PRODUCT:-}"
platform_url="${OKOU_DESKTOP_PLATFORM_URL:-}"
configuration="release"
signing_identity="${OKOU_DESKTOP_SIGNING_IDENTITY:--}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) out_dir="$2"; shift 2 ;;
    --product) product="$2"; shift 2 ;;
    --platform-url) platform_url="$2"; shift 2 ;;
    --configuration) configuration="$2"; shift 2 ;;
    --signing-identity) signing_identity="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$out_dir" ]]; then
  echo "Usage: $0 --out <dir> [--product okou|zero] [--platform-url URL]" >&2
  exit 1
fi
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "The desktop bundle can only be assembled on macOS." >&2
  exit 1
fi

product="${product:-okou}"
case "$product" in
  okou|zero) ;;
  *) echo "Unsupported desktop product: $product" >&2; exit 1 ;;
esac

# Mirrors environmentForPlatformUrl in config.ts: no explicit URL or a
# production host selects the production identity.
identity_kind="development"
platform_host="$(printf '%s' "$platform_url" | sed -E 's#^[a-zA-Z]+://##; s#[/:].*$##' | tr '[:upper:]' '[:lower:]')"
if [[ -z "$platform_url" || "$platform_host" == "app.vm0.ai" || "$platform_host" == "app.okou.ai" ]]; then
  identity_kind="production"
fi

identities="$desktop_root/src/desktop-identities.json"
display_name="$(jq -er ".${product}.${identity_kind}.displayName" "$identities")"
bundle_id="$(jq -er ".${product}.${identity_kind}.bundleId" "$identities")"
auth_scheme="$(jq -er ".${product}.${identity_kind}.authScheme" "$identities")"
auth_protocol_name="$(jq -er ".${product}.${identity_kind}.authProtocolName" "$identities")"
version="$(jq -er '.version' "$desktop_root/package.json")"
icon_base="$(jq -er ".${product}.appIconBaseName" "$desktop_root/src/desktop-brand-assets.json")"

echo "Building $display_name $version ($bundle_id, $identity_kind, $configuration)"

swift build -c "$configuration" --package-path "$package_root" --product okou-desktop
swift build -c "$configuration" --package-path "$helper_root"

app_bin_dir="$(swift build -c "$configuration" --package-path "$package_root" --show-bin-path)"
helper_bin_dir="$(swift build -c "$configuration" --package-path "$helper_root" --show-bin-path)"

app_dir="$out_dir/$display_name.app"
contents="$app_dir/Contents"
rm -rf "$app_dir"
mkdir -p "$contents/MacOS" "$contents/Resources/native" "$contents/Resources/assets"

cp "$app_bin_dir/okou-desktop" "$contents/MacOS/$display_name"
chmod 755 "$contents/MacOS/$display_name"
for helper in computer-use-helper screen-recorder-helper; do
  cp "$helper_bin_dir/$helper" "$contents/Resources/native/$helper"
  chmod 755 "$contents/Resources/native/$helper"
done

cp "$desktop_root/assets/$icon_base.icns" "$contents/Resources/icon.icns"
cp "$desktop_root/assets/$icon_base.png" "$contents/Resources/assets/$icon_base.png"
for asset in "$desktop_root"/assets/*tray-icon*.png; do
  cp "$asset" "$contents/Resources/assets/$(basename "$asset")"
done

if [[ -n "$platform_url" ]]; then
  jq -n --arg platformUrl "$platform_url" --arg product "$product" \
    '{platformUrl: $platformUrl, product: $product}' \
    > "$contents/Resources/desktop-runtime-config.json"
fi

if [[ -n "${SENTRY_DSN_DESKTOP:-}" ]]; then
  jq -n --arg dsn "$SENTRY_DSN_DESKTOP" --arg environment "${SENTRY_ENVIRONMENT:-production}" \
    '{dsn: $dsn, environment: $environment}' \
    > "$contents/Resources/desktop-sentry.json"
fi

cat > "$contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>$display_name</string>
  <key>CFBundleExecutable</key>
  <string>$display_name</string>
  <key>CFBundleIconFile</key>
  <string>icon.icns</string>
  <key>CFBundleIdentifier</key>
  <string>$bundle_id</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>$display_name</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>$version</string>
  <key>CFBundleVersion</key>
  <string>$version</string>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key>
      <string>$auth_protocol_name</string>
      <key>CFBundleURLSchemes</key>
      <array>
        <string>$auth_scheme</string>
      </array>
    </dict>
  </array>
  <key>LSApplicationCategoryType</key>
  <string>public.app-category.productivity</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSMicrophoneUsageDescription</key>
  <string>Okou records your microphone so a screen recording can carry your narration.</string>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
  <key>NSSupportsAutomaticGraphicsSwitching</key>
  <true/>
</dict>
</plist>
PLIST
printf 'APPL????' > "$contents/PkgInfo"
plutil -lint "$contents/Info.plist"

codesign --force --deep --sign "$signing_identity" "$app_dir"
codesign --verify --deep --strict "$app_dir"

zip_name="$(printf '%s' "$display_name" | tr -d ' ')-darwin-arm64-swift.zip"
rm -f "$out_dir/$zip_name"
ditto -c -k --keepParent "$app_dir" "$out_dir/$zip_name"

echo "app=$app_dir"
echo "zip=$out_dir/$zip_name"
