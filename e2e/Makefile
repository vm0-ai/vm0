# BATS E2E Test Suite for CLI

SHELL := /bin/bash
BATS := test/libs/bats/bin/bats
TESTS_DIR := tests

.PHONY: test iinit prepare-test

# Initialize git submodules
init:
	@git submodule update --init --recursive
	
# Run all tests
test:
	@$(BATS) --abort $(TESTS_DIR)/**/*.bats

