# Trigger Engine Documentation Index

Welcome to the Trigger Engine guide. This documentation covers the architecture, flows, and APIs of the Zero Data Fabric trigger system.

## 📖 Guides

1.  **[Architecture Guide](architecture.md)**
    *   System components and high-level data flow.
    *   Database schema and table roles.
    *   The Trigger Lifecycle.

2.  **[Sequence Diagrams](sequence.md)**
    *   Creation & Deployment journey.
    *   Firing & Action execution journey.
    *   Deletion journey.

3.  **[API Reference](api.md)**
    *   Backend Orchestrator APIs.
    *   Trigger Engine internal APIs.
    *   Action payload structures.

4.  **[Advanced Features](advanced-features.md)**
    *   Variable resolution (`newRow`, `oldRow`).
    *   Scheduling (Relative & CRON).
    *   AutoDrop (Self-cleaning triggers).

5.  **[Syntax Reference](syntax.md)**
    *   Root schema properties.
    *   Full list of Event and Execute types.
    *   Configurable options for each action.

## 🚀 Quick Start

To see triggers in action:
1.  Configure a **Notification Channel** in Settings.
2.  Create a **Trigger** in the Control Plane.
3.  Click **Deploy** to physically create the trigger in the database.
4.  Modify data in the target table and monitor the **Execution Logs**.
