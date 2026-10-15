PROFILE ?= default
REGION  ?= us-east-1
COMPOSE ?= $(shell command -v docker >/dev/null 2>&1 && echo "docker compose" || echo "finch compose")

.PHONY: install dynamodb test e2e build dev-game dev-admin deploy

install:
	npm ci && cd infra && npm ci

dynamodb:
	$(COMPOSE) up -d dynamodb

test: dynamodb
	npm test
	cd infra && npm test

e2e: dynamodb
	npm run test:e2e

build:
	npm run build

dev-game: dynamodb
	npm run dev:game

dev-admin:
	npm run dev:admin

deploy: test build
	AWS_PROFILE=$(PROFILE) DEPLOY_REGION=$(REGION) ./scripts/deploy.sh
