# API Testing

API route tests should construct cases by calling production API endpoints and
verify results through production API endpoints.

Allowed test helpers are thin API clients: they can authenticate a test actor,
call a route, post a webhook, or mock an external provider. They should not
write DB schemas, call services, or assert service output.

For API tests, DB schema imports, service imports, DB assertions, service
assertions, and helper seeders that bypass endpoints are internal implementation
tests. Use them only for the narrow exceptions described in
[Testing External Behavior](./testing-external-behavior.md).
