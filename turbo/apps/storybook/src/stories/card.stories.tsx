import type { Meta, StoryObj } from "@storybook/react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  Button,
} from "@vm0/ui";

/**
 * Card component for displaying content in a contained box with optional header and footer.
 * Built with compound components pattern for flexible composition.
 */
const meta = {
  title: "Components/Card",
  component: Card,
  parameters: {
    layout: "centered",
  },
  tags: ["autodocs"],
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

// Default card with all parts
export const Default: Story = {
  render: () => (
    <Card className="w-[350px]">
      <CardHeader>
        <CardTitle>Card Title</CardTitle>
        <CardDescription>Card description goes here.</CardDescription>
      </CardHeader>
      <CardContent>
        <p>Card content goes here. You can put any content inside.</p>
      </CardContent>
      <CardFooter>
        <Button>Action</Button>
      </CardFooter>
    </Card>
  ),
};

// Simple card with just content
export const Simple: Story = {
  render: () => (
    <Card className="w-[350px] p-6">
      <p>A simple card with just content, no header or footer.</p>
    </Card>
  ),
};

// Card with header only
export const WithHeader: Story = {
  render: () => (
    <Card className="w-[350px]">
      <CardHeader>
        <CardTitle>Notifications</CardTitle>
        <CardDescription>You have 3 unread messages.</CardDescription>
      </CardHeader>
      <CardContent>
        <p>Check your inbox for the latest updates.</p>
      </CardContent>
    </Card>
  ),
};

// Card with footer only
export const WithFooter: Story = {
  render: () => (
    <Card className="w-[350px]">
      <CardContent className="pt-6">
        <p>This card has a footer with action buttons.</p>
      </CardContent>
      <CardFooter className="flex justify-between">
        <Button variant="outline">Cancel</Button>
        <Button>Save</Button>
      </CardFooter>
    </Card>
  ),
};

// Complete card example
export const Complete: Story = {
  render: () => (
    <Card className="w-[400px]">
      <CardHeader>
        <CardTitle>Create Project</CardTitle>
        <CardDescription>Deploy your new project in one-click.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <label className="text-sm font-medium">Name</label>
            <input
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              placeholder="My Project"
            />
          </div>
          <div className="grid gap-2">
            <label className="text-sm font-medium">Framework</label>
            <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
              <option>Next.js</option>
              <option>Remix</option>
              <option>Astro</option>
            </select>
          </div>
        </div>
      </CardContent>
      <CardFooter className="flex justify-between">
        <Button variant="outline">Cancel</Button>
        <Button>Deploy</Button>
      </CardFooter>
    </Card>
  ),
};

// Multiple cards layout
export const CardGrid: Story = {
  render: () => (
    <div className="grid grid-cols-2 gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Total Revenue</CardTitle>
          <CardDescription>+20.1% from last month</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-bold">$45,231.89</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Subscriptions</CardTitle>
          <CardDescription>+180.1% from last month</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-bold">+2350</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Sales</CardTitle>
          <CardDescription>+19% from last month</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-bold">+12,234</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Active Now</CardTitle>
          <CardDescription>+201 since last hour</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-bold">+573</p>
        </CardContent>
      </Card>
    </div>
  ),
};
