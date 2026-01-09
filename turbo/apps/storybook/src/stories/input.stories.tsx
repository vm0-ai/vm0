import type { Meta, StoryObj } from "@storybook/react";
import { Input } from "@vm0/ui";

/**
 * Input component for text entry with various states and types.
 * Supports all native input types and integrates with form libraries.
 */
const meta = {
  title: "Components/Input",
  component: Input,
  parameters: {
    layout: "centered",
  },
  tags: ["autodocs"],
  argTypes: {
    type: {
      control: "select",
      options: ["text", "email", "password", "number", "search", "tel", "url"],
      description: "The type of input",
    },
    placeholder: {
      control: "text",
      description: "Placeholder text for the input",
    },
    disabled: {
      control: "boolean",
      description: "Whether the input is disabled",
    },
  },
} satisfies Meta<typeof Input>;

export default meta;
type Story = StoryObj<typeof meta>;

// Default input
export const Default: Story = {
  args: {
    type: "text",
  },
};

// With placeholder
export const WithPlaceholder: Story = {
  args: {
    type: "text",
    placeholder: "Enter your name...",
  },
};

// Disabled state
export const Disabled: Story = {
  args: {
    type: "text",
    placeholder: "Disabled input",
    disabled: true,
  },
};

// With default value
export const WithValue: Story = {
  args: {
    type: "text",
    defaultValue: "Hello World",
  },
};

// Email input
export const Email: Story = {
  args: {
    type: "email",
    placeholder: "email@example.com",
  },
};

// Password input
export const Password: Story = {
  args: {
    type: "password",
    placeholder: "Enter password",
  },
};

// Number input
export const Number: Story = {
  args: {
    type: "number",
    placeholder: "Enter a number",
  },
};

// Search input
export const Search: Story = {
  args: {
    type: "search",
    placeholder: "Search...",
  },
};

// File input
export const File: Story = {
  args: {
    type: "file",
  },
};

// With label (composition example)
export const WithLabel: Story = {
  render: () => (
    <div className="grid w-full max-w-sm items-center gap-1.5">
      <label htmlFor="email" className="text-sm font-medium">
        Email
      </label>
      <Input type="email" id="email" placeholder="Enter your email" />
    </div>
  ),
};

// With label and helper text
export const WithHelperText: Story = {
  render: () => (
    <div className="grid w-full max-w-sm items-center gap-1.5">
      <label htmlFor="email-helper" className="text-sm font-medium">
        Email
      </label>
      <Input type="email" id="email-helper" placeholder="Enter your email" />
      <p className="text-sm text-muted-foreground">
        We&apos;ll never share your email with anyone else.
      </p>
    </div>
  ),
};

// Error state (with styling)
export const WithError: Story = {
  render: () => (
    <div className="grid w-full max-w-sm items-center gap-1.5">
      <label htmlFor="email-error" className="text-sm font-medium">
        Email
      </label>
      <Input
        type="email"
        id="email-error"
        placeholder="Enter your email"
        className="border-red-500 focus-visible:ring-red-500"
        defaultValue="invalid-email"
      />
      <p className="text-sm text-red-500">
        Please enter a valid email address.
      </p>
    </div>
  ),
};

// All input types showcase
export const AllTypes: Story = {
  render: () => (
    <div className="grid w-full max-w-sm gap-4">
      <div className="grid gap-1.5">
        <label className="text-sm font-medium">Text</label>
        <Input type="text" placeholder="Text input" />
      </div>
      <div className="grid gap-1.5">
        <label className="text-sm font-medium">Email</label>
        <Input type="email" placeholder="email@example.com" />
      </div>
      <div className="grid gap-1.5">
        <label className="text-sm font-medium">Password</label>
        <Input type="password" placeholder="Password" />
      </div>
      <div className="grid gap-1.5">
        <label className="text-sm font-medium">Number</label>
        <Input type="number" placeholder="0" />
      </div>
      <div className="grid gap-1.5">
        <label className="text-sm font-medium">Search</label>
        <Input type="search" placeholder="Search..." />
      </div>
      <div className="grid gap-1.5">
        <label className="text-sm font-medium">Tel</label>
        <Input type="tel" placeholder="+1 (555) 000-0000" />
      </div>
      <div className="grid gap-1.5">
        <label className="text-sm font-medium">URL</label>
        <Input type="url" placeholder="https://example.com" />
      </div>
      <div className="grid gap-1.5">
        <label className="text-sm font-medium">File</label>
        <Input type="file" />
      </div>
    </div>
  ),
};
