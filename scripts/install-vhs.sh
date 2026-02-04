#!/usr/bin/env bash

sudo apt update
sudo apt install -y ffmpeg ttyd

ARCH=$(dpkg --print-architecture)
wget "https://github.com/charmbracelet/vhs/releases/download/v0.10.0/vhs_0.10.0_Linux_${ARCH}.tar.gz" -O /tmp/vhs.tar.gz
tar zxvf /tmp/vhs.tar.gz -C /tmp
mv /tmp/vhs_0.10.0_Linux_${ARCH}/vhs ~/.local/bin/