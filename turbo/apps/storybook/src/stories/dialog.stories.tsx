import type { Meta, StoryObj } from "@storybook/react";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogClose,
  Button,
  Input,
} from "@vm0/ui";

/**
 * Dialog component for displaying modal content.
 * Built on Radix UI Dialog primitive with accessibility features.
 */
const meta = {
  title: "Components/Dialog",
  component: Dialog,
  parameters: {
    layout: "centered",
  },
  tags: ["autodocs"],
} satisfies Meta<typeof Dialog>;

export default meta;
type Story = StoryObj<typeof meta>;

// Default dialog
export const Default: Story = {
  render: () => (
    <Dialog>
      <DialogTrigger asChild>
        <Button>Open Dialog</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Dialog Title</DialogTitle>
          <DialogDescription>
            This is a dialog description that explains what the dialog is about.
          </DialogDescription>
        </DialogHeader>
        <p>Dialog content goes here.</p>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button>Confirm</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
};

// Dialog with form
export const WithForm: Story = {
  render: () => (
    <Dialog>
      <DialogTrigger asChild>
        <Button>Edit Profile</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Edit Profile</DialogTitle>
          <DialogDescription>
            Make changes to your profile here. Click save when you&apos;re done.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="grid grid-cols-4 items-center gap-4">
            <label htmlFor="name" className="text-right text-sm font-medium">
              Name
            </label>
            <Input id="name" defaultValue="John Doe" className="col-span-3" />
          </div>
          <div className="grid grid-cols-4 items-center gap-4">
            <label
              htmlFor="username"
              className="text-right text-sm font-medium"
            >
              Username
            </label>
            <Input
              id="username"
              defaultValue="@johndoe"
              className="col-span-3"
            />
          </div>
        </div>
        <DialogFooter>
          <Button type="submit">Save changes</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
};

// Confirmation dialog
export const Confirmation: Story = {
  render: () => (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="destructive">Delete Account</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Are you sure?</DialogTitle>
          <DialogDescription>
            This action cannot be undone. This will permanently delete your
            account and remove your data from our servers.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button variant="destructive">Delete</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
};

// Dialog with custom content
export const CustomContent: Story = {
  render: () => (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">View Details</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Order Details</DialogTitle>
          <DialogDescription>
            Order #12345 - Placed on Jan 1, 2024
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-lg border p-4">
            <div className="flex justify-between">
              <span className="font-medium">Product Name</span>
              <span>$99.00</span>
            </div>
            <p className="text-sm text-muted-foreground">Quantity: 2</p>
          </div>
          <div className="rounded-lg border p-4">
            <div className="flex justify-between">
              <span className="font-medium">Another Product</span>
              <span>$49.00</span>
            </div>
            <p className="text-sm text-muted-foreground">Quantity: 1</p>
          </div>
          <div className="flex justify-between border-t pt-4 font-medium">
            <span>Total</span>
            <span>$247.00</span>
          </div>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button>Close</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
};

// Dialog without close button (controlled)
export const SimpleAlert: Story = {
  render: () => (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="secondary">Show Alert</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>Welcome!</DialogTitle>
          <DialogDescription>
            Thank you for signing up. Your account has been created
            successfully.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="sm:justify-center">
          <DialogClose asChild>
            <Button>Got it</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
};
