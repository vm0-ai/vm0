# BATS E2E Test Suite for CLI

SHELL := /bin/bash
BATS := test/libs/bats/bin/bats
TESTS_DIR := tests

.PHONY: test iinit prepare-test

# Initialize git submodules
init:
	@git submodule update --init --recursive
	
# Run all tests
# -j 4: run up to 4 files in parallel
# --no-parallelize-within-files: run tests sequentially within each file
test:
	@$(BATS) --abort -j 4 --no-parallelize-within-files $(TESTS_DIR)/**/*.bats

