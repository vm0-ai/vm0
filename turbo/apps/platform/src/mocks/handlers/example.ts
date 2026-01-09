/**
 * Example API Handlers
 *
 * This file demonstrates how to create MSW handlers for API mocking.
 * Use this as a template for creating your own handlers.
 */

import { http, HttpResponse } from "msw";

export interface User {
  id: string;
  name: string;
  email: string;
}

export interface ApiError {
  error: string;
  message: string;
}

// Mock data
const mockUsers: User[] = [
  { id: "1", name: "Alice", email: "alice@example.com" },
  { id: "2", name: "Bob", email: "bob@example.com" },
];

export const exampleHandlers = [
  // GET /api/users - List all users
  http.get("/api/users", () => {
    return HttpResponse.json(mockUsers);
  }),

  // GET /api/users/:id - Get user by ID
  http.get("/api/users/:id", ({ params }) => {
    const { id } = params;
    const user = mockUsers.find((u) => u.id === id);

    if (!user) {
      return HttpResponse.json(
        { error: "not_found", message: "User not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    return HttpResponse.json(user);
  }),

  // POST /api/users - Create a new user
  http.post("/api/users", async ({ request }) => {
    const body = (await request.json()) as { name: string; email: string };
    const newUser: User = {
      id: String(mockUsers.length + 1),
      name: body.name,
      email: body.email,
    };

    return HttpResponse.json(newUser, { status: 201 });
  }),
];
