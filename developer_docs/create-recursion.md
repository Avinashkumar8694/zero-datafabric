# How to Create Recursive Views (Scenario Guide)

This guide describes how to construct recursive queries (Common Table Expressions / CTEs) inside the Zero Data Fabric to map structural hierarchies and nested relationships.

---

## 1. Supported Parameters & Rules

Within your metadata manifest, the recursive view configuration block utilizes:

* **`recursive`**: `Boolean` | Must equal `true` to declare a recursive CTE.
* **`query.with`**: `Array` | Contains the CTE specifications.
  * `name`: `String` | Unique temporary table alias.
  * `columns`: `Array` | Column name strings projected by the recursive loop.
  * `base`: `Object` | Base driving select query (defines the root elements).
  * `unionAll`: `Object` | Loop step select query, joined back to the temporary table name.

---

## 2. 10 Recursive View Scenarios

To apply any of the manifests below, write the JSON to a file (e.g., `manifest.json`) and run the metadata apply API call:

* **API Endpoint**: `POST /api/metadata/apply`
* **Headers**:
  * `Authorization: Bearer $JWT_TOKEN`
  * `x-tenant-id: tenant_A`
  * `Content-Type: multipart/form-data`

```bash
curl -X POST http://localhost:4000/api/metadata/apply \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "x-tenant-id: tenant_A" \
  -F "file=@manifest.json"
```

---

### Scenario 1: Organization Employee Reporting Hierarchy
* **Description**: Map employee structures recursively starting from managers.
* **Manifest JSON**:
```json
{
  "type": "VIEW",
  "name": "org_hierarchy",
  "recursive": true,
  "query": {
    "with": [
      {
        "name": "emp_path",
        "columns": ["id", "name", "manager_id", "level"],
        "base": {
          "select": ["id", "name", "manager_id", { "expression": "1", "alias": "level" }],
          "from": { "resource": "employees" },
          "where": [{ "column": "manager_id", "operator": "IS_NULL" }]
        },
        "unionAll": {
          "select": ["e.id", "e.name", "e.manager_id", { "expression": "ep.level + 1" }],
          "from": { "resource": "employees", "alias": "e" },
          "joins": [
            {
              "type": "INNER",
              "resource": "emp_path",
              "alias": "ep",
              "on": { "left": "e.manager_id", "operator": "EQ", "right": "ep.id" }
            }
          ]
        }
      }
    ],
    "select": ["*"],
    "from": { "resource": "emp_path" }
  }
}
```
* **Compiled Database SQL**:
```sql
CREATE VIEW "public"."org_hierarchy" AS
WITH RECURSIVE emp_path(id, name, manager_id, level) AS (
  SELECT id, name, manager_id, 1 AS level FROM "public"."employees" WHERE manager_id IS NULL
  UNION ALL
  SELECT e.id, e.name, e.manager_id, ep.level + 1 FROM "public"."employees" e
  INNER JOIN emp_path ep ON e.manager_id = ep.id
)
SELECT * FROM emp_path;
```

---

### Scenario 2: Product Category Dependency Tree
* **Description**: Recursively trace parent-child subcategory dependencies.
* **Manifest JSON**:
```json
{
  "type": "VIEW",
  "name": "category_tree",
  "recursive": true,
  "query": {
    "with": [
      {
        "name": "cat_path",
        "columns": ["id", "name", "parent_id", "depth"],
        "base": {
          "select": ["id", "name", "parent_id", { "expression": "0", "alias": "depth" }],
          "from": { "resource": "categories" },
          "where": [{ "column": "parent_id", "operator": "IS_NULL" }]
        },
        "unionAll": {
          "select": ["c.id", "c.name", "c.parent_id", { "expression": "cp.depth + 1" }],
          "from": { "resource": "categories", "alias": "c" },
          "joins": [
            {
              "type": "INNER",
              "resource": "cat_path",
              "alias": "cp",
              "on": { "left": "c.parent_id", "operator": "EQ", "right": "cp.id" }
            }
          ]
        }
      }
    ],
    "select": ["*"],
    "from": { "resource": "cat_path" }
  }
}
```
* **Compiled Database SQL**:
```sql
CREATE VIEW "public"."category_tree" AS
WITH RECURSIVE cat_path(id, name, parent_id, depth) AS (
  SELECT id, name, parent_id, 0 AS depth FROM "public"."categories" WHERE parent_id IS NULL
  UNION ALL
  SELECT c.id, c.name, c.parent_id, cp.depth + 1 FROM "public"."categories" c
  INNER JOIN cat_path cp ON c.parent_id = cp.id
)
SELECT * FROM cat_path;
```

---

### Scenario 3: Bill of Materials (BOM) Parts Assembly
* **Description**: Trace assembled raw parts and nested product components.
* **Manifest JSON**:
```json
{
  "type": "VIEW",
  "name": "bom_assembly",
  "recursive": true,
  "query": {
    "with": [
      {
        "name": "part_tree",
        "columns": ["parent_part_id", "child_part_id", "quantity", "level"],
        "base": {
          "select": ["parent_part_id", "child_part_id", "quantity", { "expression": "1", "alias": "level" }],
          "from": { "resource": "part_links" },
          "where": [{ "column": "parent_part_id", "operator": "IS_NULL" }]
        },
        "unionAll": {
          "select": ["l.parent_part_id", "l.child_part_id", "l.quantity", { "expression": "pt.level + 1" }],
          "from": { "resource": "part_links", "alias": "l" },
          "joins": [
            {
              "type": "INNER",
              "resource": "part_tree",
              "alias": "pt",
              "on": { "left": "l.parent_part_id", "operator": "EQ", "right": "pt.child_part_id" }
            }
          ]
        }
      }
    ],
    "select": ["*"],
    "from": { "resource": "part_tree" }
  }
}
```
* **Compiled Database SQL**:
```sql
CREATE VIEW "public"."bom_assembly" AS
WITH RECURSIVE part_tree(parent_part_id, child_part_id, quantity, level) AS (
  SELECT parent_part_id, child_part_id, quantity, 1 AS level FROM "public"."part_links" WHERE parent_part_id IS NULL
  UNION ALL
  SELECT l.parent_part_id, l.child_part_id, l.quantity, pt.level + 1 FROM "public"."part_links" l
  INNER JOIN part_tree pt ON l.parent_part_id = pt.child_part_id
)
SELECT * FROM part_tree;
```

---

### Scenario 4: Transit Route Node Path Tracking
* **Description**: Track all reachable destinations starting from a root distribution node.
* **Manifest JSON**:
```json
{
  "type": "VIEW",
  "name": "distribution_routes",
  "recursive": true,
  "query": {
    "with": [
      {
        "name": "route_path",
        "columns": ["origin", "destination", "hops"],
        "base": {
          "select": ["origin", "destination", { "expression": "1", "alias": "hops" }],
          "from": { "resource": "flights" },
          "where": [{ "column": "origin", "operator": "EQ", "value": "JFK" }]
        },
        "unionAll": {
          "select": ["f.origin", "f.destination", { "expression": "rp.hops + 1" }],
          "from": { "resource": "flights", "alias": "f" },
          "joins": [
            {
              "type": "INNER",
              "resource": "route_path",
              "alias": "rp",
              "on": { "left": "f.origin", "operator": "EQ", "right": "rp.destination" }
            }
          ]
        }
      }
    ],
    "select": ["*"],
    "from": { "resource": "route_path" }
  }
}
```
* **Compiled Database SQL**:
```sql
CREATE VIEW "public"."distribution_routes" AS
WITH RECURSIVE route_path(origin, destination, hops) AS (
  SELECT origin, destination, 1 AS hops FROM "public"."flights" WHERE origin = 'JFK'
  UNION ALL
  SELECT f.origin, f.destination, rp.hops + 1 FROM "public"."flights" f
  INNER JOIN route_path rp ON f.origin = rp.destination
)
SELECT * FROM route_path;
```

---

### Scenario 5: Threaded Discussion Comments Hierarchy
* **Description**: Trace hierarchical forum response maps recursively.
* **Manifest JSON**:
```json
{
  "type": "VIEW",
  "name": "comment_threads",
  "recursive": true,
  "query": {
    "with": [
      {
        "name": "thread_path",
        "columns": ["id", "parent_comment_id", "body", "level"],
        "base": {
          "select": ["id", "parent_comment_id", "body", { "expression": "1", "alias": "level" }],
          "from": { "resource": "comments" },
          "where": [{ "column": "parent_comment_id", "operator": "IS_NULL" }]
        },
        "unionAll": {
          "select": ["c.id", "c.parent_comment_id", "c.body", { "expression": "tp.level + 1" }],
          "from": { "resource": "comments", "alias": "c" },
          "joins": [
            {
              "type": "INNER",
              "resource": "thread_path",
              "alias": "tp",
              "on": { "left": "c.parent_comment_id", "operator": "EQ", "right": "tp.id" }
            }
          ]
        }
      }
    ],
    "select": ["*"],
    "from": { "resource": "thread_path" }
  }
}
```
* **Compiled Database SQL**:
```sql
CREATE VIEW "public"."comment_threads" AS
WITH RECURSIVE thread_path(id, parent_comment_id, body, level) AS (
  SELECT id, parent_comment_id, body, 1 AS level FROM "public"."comments" WHERE parent_comment_id IS NULL
  UNION ALL
  SELECT c.id, c.parent_comment_id, c.body, tp.level + 1 FROM "public"."comments" c
  INNER JOIN thread_path tp ON c.parent_comment_id = tp.id
)
SELECT * FROM thread_path;
```

---

### Scenario 6: Cost Accumulation in Catalog Assemblies
* **Description**: Sum structural prices recursively inside component assembly maps.
* **Manifest JSON**:
```json
{
  "type": "VIEW",
  "name": "accumulated_costs",
  "recursive": true,
  "query": {
    "with": [
      {
        "name": "cost_path",
        "columns": ["item_id", "total_cost"],
        "base": {
          "select": ["id", { "expression": "price", "alias": "total_cost" }],
          "from": { "resource": "raw_materials" }
        },
        "unionAll": {
          "select": ["a.assembly_id", { "expression": "cp.total_cost + a.processing_fee" }],
          "from": { "resource": "assemblies", "alias": "a" },
          "joins": [
            {
              "type": "INNER",
              "resource": "cost_path",
              "alias": "cp",
              "on": { "left": "a.material_id", "operator": "EQ", "right": "cp.item_id" }
            }
          ]
        }
      }
    ],
    "select": ["*"],
    "from": { "resource": "cost_path" }
  }
}
```
* **Compiled Database SQL**:
```sql
CREATE VIEW "public"."accumulated_costs" AS
WITH RECURSIVE cost_path(item_id, total_cost) AS (
  SELECT id, price AS total_cost FROM "public"."raw_materials"
  UNION ALL
  SELECT a.assembly_id, cp.total_cost + a.processing_fee FROM "public"."assemblies" a
  INNER JOIN cost_path cp ON a.material_id = cp.item_id
)
SELECT * FROM cost_path;
```

---

### Scenario 7: Network Node Graph Traversal
* **Description**: Trace connected network links to verify paths.
* **Manifest JSON**:
```json
{
  "type": "VIEW",
  "name": "network_graph",
  "recursive": true,
  "query": {
    "with": [
      {
        "name": "graph_path",
        "columns": ["source_node", "target_node", "depth"],
        "base": {
          "select": ["source_node", "target_node", { "expression": "1", "alias": "depth" }],
          "from": { "resource": "network_links" },
          "where": [{ "column": "source_node", "operator": "EQ", "value": "A" }]
        },
        "unionAll": {
          "select": ["l.source_node", "l.target_node", { "expression": "gp.depth + 1" }],
          "from": { "resource": "network_links", "alias": "l" },
          "joins": [
            {
              "type": "INNER",
              "resource": "graph_path",
              "alias": "gp",
              "on": { "left": "l.source_node", "operator": "EQ", "right": "gp.target_node" }
            }
          ]
        }
      }
    ],
    "select": ["*"],
    "from": { "resource": "graph_path" }
  }
}
```
* **Compiled Database SQL**:
```sql
CREATE VIEW "public"."network_graph" AS
WITH RECURSIVE graph_path(source_node, target_node, depth) AS (
  SELECT source_node, target_node, 1 AS depth FROM "public"."network_links" WHERE source_node = 'A'
  UNION ALL
  SELECT l.source_node, l.target_node, gp.depth + 1 FROM "public"."network_links" l
  INNER JOIN graph_path gp ON l.source_node = gp.target_node
)
SELECT * FROM graph_path;
```

---

### Scenario 8: Project Task Dependencies Map
* **Description**: Trace nested predecessor task schedules.
* **Manifest JSON**:
```json
{
  "type": "VIEW",
  "name": "task_schedule",
  "recursive": true,
  "query": {
    "with": [
      {
        "name": "task_path",
        "columns": ["task_id", "dependency_id", "seq"],
        "base": {
          "select": ["id", "dependency_id", { "expression": "1", "alias": "seq" }],
          "from": { "resource": "tasks" },
          "where": [{ "column": "dependency_id", "operator": "IS_NULL" }]
        },
        "unionAll": {
          "select": ["t.id", "t.dependency_id", { "expression": "tp.seq + 1" }],
          "from": { "resource": "tasks", "alias": "t" },
          "joins": [
            {
              "type": "INNER",
              "resource": "task_path",
              "alias": "tp",
              "on": { "left": "t.dependency_id", "operator": "EQ", "right": "tp.task_id" }
            }
          ]
        }
      }
    ],
    "select": ["*"],
    "from": { "resource": "task_path" }
  }
}
```
* **Compiled Database SQL**:
```sql
CREATE VIEW "public"."task_schedule" AS
WITH RECURSIVE task_path(task_id, dependency_id, seq) AS (
  SELECT id, dependency_id, 1 AS seq FROM "public"."tasks" WHERE dependency_id IS NULL
  UNION ALL
  SELECT t.id, t.dependency_id, tp.seq + 1 FROM "public"."tasks" t
  INNER JOIN task_path tp ON t.dependency_id = tp.task_id
)
SELECT * FROM task_path;
```

---

### Scenario 9: Access Control Role Hierarchy Inheritance
* **Description**: Map inherited permissions across nested operational roles.
* **Manifest JSON**:
```json
{
  "type": "VIEW",
  "name": "role_inheritance",
  "recursive": true,
  "query": {
    "with": [
      {
        "name": "role_path",
        "columns": ["role_name", "inherited_role", "level"],
        "base": {
          "select": ["role_name", "inherited_role", { "expression": "1", "alias": "level" }],
          "from": { "resource": "role_links" },
          "where": [{ "column": "inherited_role", "operator": "IS_NULL" }]
        },
        "unionAll": {
          "select": ["rl.role_name", "rl.inherited_role", { "expression": "rp.level + 1" }],
          "from": { "resource": "role_links", "alias": "rl" },
          "joins": [
            {
              "type": "INNER",
              "resource": "role_path",
              "alias": "rp",
              "on": { "left": "rl.inherited_role", "operator": "EQ", "right": "rp.role_name" }
            }
          ]
        }
      }
    ],
    "select": ["*"],
    "from": { "resource": "role_path" }
  }
}
```
* **Compiled Database SQL**:
```sql
CREATE VIEW "public"."role_inheritance" AS
WITH RECURSIVE role_path(role_name, inherited_role, level) AS (
  SELECT role_name, inherited_role, 1 AS level FROM "public"."role_links" WHERE inherited_role IS NULL
  UNION ALL
  SELECT rl.role_name, rl.inherited_role, rp.level + 1 FROM "public"."role_links" rl
  INNER JOIN role_path rp ON rl.inherited_role = rp.role_name
)
SELECT * FROM role_path;
```

---

### Scenario 10: Multi-Level Warehousing Paths
* **Description**: Trace storage transfer routes recursively inside warehousing manifests.
* **Manifest JSON**:
```json
{
  "type": "VIEW",
  "name": "warehouse_routes",
  "recursive": true,
  "query": {
    "with": [
      {
        "name": "route_path",
        "columns": ["source_id", "target_id", "stops"],
        "base": {
          "select": ["source_id", "target_id", { "expression": "1", "alias": "stops" }],
          "from": { "resource": "transfers" },
          "where": [{ "column": "source_id", "operator": "EQ", "value": "hub-01" }]
        },
        "unionAll": {
          "select": ["tr.source_id", "tr.target_id", { "expression": "rp.stops + 1" }],
          "from": { "resource": "transfers", "alias": "tr" },
          "joins": [
            {
              "type": "INNER",
              "resource": "route_path",
              "alias": "rp",
              "on": { "left": "tr.source_id", "operator": "EQ", "right": "rp.target_id" }
            }
          ]
        }
      }
    ],
    "select": ["*"],
    "from": { "resource": "route_path" }
  }
}
```
* **Compiled Database SQL**:
```sql
CREATE VIEW "public"."warehouse_routes" AS
WITH RECURSIVE route_path(source_id, target_id, stops) AS (
  SELECT source_id, target_id, 1 AS stops FROM "public"."transfers" WHERE source_id = 'hub-01'
  UNION ALL
  SELECT tr.source_id, tr.target_id, rp.stops + 1 FROM "public"."transfers" tr
  INNER JOIN route_path rp ON tr.source_id = rp.target_id
)
SELECT * FROM route_path;
```
