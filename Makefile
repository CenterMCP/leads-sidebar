.PHONY: run build ui test check
run:
	go run ./cmd/server
build:
	go build -o build/leads-sidebar ./cmd/server
ui:
	npm ci --ignore-scripts
	npm run typecheck
	npm run build:ui
test:
	go test -race ./...
check:
	go vet ./...
	npm run typecheck
