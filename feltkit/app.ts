/**
 * The application: its name, who may do what, and its data.
 *
 * Everything here is stored in one FeltDB instance per environment. In development
 * that is .feltkit/development/state — run `npx feltkit inspect` to see it.
 */
import { feltkit, s } from "@feltdb/feltkit";

export const app = feltkit({
  name: "boundry-connector",
  description: "A small task manager that demonstrates the whole FeltKit platform.",
  // Roles grant AppPort permissions. "tasks.*" grants every tasks.<x> permission.
  roles: {
    // Members use the app and Studio's agent (feltkit.agent.*: create, approve, and follow agent tasks).
    // notifications.*: a principal reads, marks, and dismisses only its own notifications.
    // webhooks.emit + webhooks.deliver: their changes notify registered endpoints (task.created,
    // task.completed); each delivery runs as the person whose change emitted it.
    member: ["projects.*", "tasks.*", "files.*", "notifications.*", "webhooks.emit", "webhooks.deliver", "feltkit.agent.*"],
    // Viewers read. They can see agent tasks but not start or approve them.
    viewer: ["projects.read", "tasks.read", "files.read", "notifications.read", "feltkit.agent.read"],
    // Agents can read, complete tasks, and leave notes. They cannot create or delete.
    // feltkit.agent.*: discover the app (feltkit_context), work tasks, propose actions; a person approves.
    agent: ["projects.read", "tasks.read", "tasks.complete", "tasks.note", "files.read", "files.write", "notifications.send", "webhooks.emit", "webhooks.deliver", "feltkit.agent.*"],
    // Admins configure the app in Studio → Services: the model (intelligence.*), stored
    // credentials (credential.*), configuration, API keys, webhooks, jobs, and schedules.
    // Credentials are stored by reference; the value never enters FeltDB.
    // feltkit.operations.*: in production, admins are Studio's operators (npx feltkit operator grant).
    admin: ["intelligence.*", "credential.*", "configuration.*", "apikeys.*", "webhooks.*", "jobs.*", "schedules.*", "feltkit.operations.*"],
  },
  // People sign up and sign in with an e-mail address and a password (stored in this app's FeltDB;
  // only a hash of the password). A new account is a member.
  auth: { accounts: { roles: ["member"] } },
  // Development-only identities. Sign in as them from the app or the dashboard.
  dev: {
    users: [
      { id: "ada", name: "Ada Lovelace", roles: ["member", "admin"] },
      { id: "grace", name: "Grace Hopper", roles: ["viewer"] },
    ],
  },
  // AppPort Services, stored in this app's FeltDB instance, each configured in Studio →
  // Services. Intelligence is the model the agent decides with (Studio → Models).
  services: {
    files: true,
    // The types this app sends; Studio offers them when you send one by hand.
    notifications: { types: ["task.completed"] },
    configuration: true,
    // A request authenticated by an API key holds these roles.
    apiKeys: { roles: ["member"] },
    // The events this app emits (feltkit/tasks.ts); Studio offers them when you register an endpoint.
    webhooks: { events: ["task.created", "task.completed"] },
    // Job type → the mutation that runs it, as the principal that queued it, with retries.
    jobs: { handlers: { "projects.clear-completed": "projects:clearCompleted" } },
    schedules: true,
    intelligence: true,
  },
});

export const projects = app.collection("projects", {
  name: s.string({ minLength: 1, maxLength: 80 }),
  createdAt: s.number(),
  createdBy: s.string(),
});

export const tasks = app.collection("tasks", {
  projectId: s.string(),
  title: s.string({ minLength: 1, maxLength: 200 }),
  details: s.optional(s.string({ maxLength: 4000 })),
  done: s.boolean(),
  createdAt: s.number(),
  createdBy: s.string(),
  completedAt: s.optional(s.number()),
  completedBy: s.optional(s.string()),
});
