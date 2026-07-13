# How to Create Recursive Queries & Views

This guide describes how to construct recursive views (Common Table Expressions / CTEs) inside Zero Data Fabric to trace graph hierarchies and management trees.

---

## 1. Defining Recursive Views in Manifest

Add a recursive view configuration mapping a base query and recursive `unionAll` query block inside the schema resource definitions:

```json
{
  "type": "VIEW",
  "name": "org_hierarchy_recursive",
  "recursive": true,
  "query": {
    "with": [
      {
        "name": "emp_path",
        "columns": ["id", "name", "manager_id", "path", "level"],
        "base": {
          "select": [
            "id",
            "name",
            "manager_id",
            { "expression": "name", "alias": "path" },
            { "expression": "1", "alias": "level" }
          ],
          "from": { "resource": "employees" },
          "where": [
            { "column": "manager_id", "operator": "IS_NULL" }
          ]
        },
        "unionAll": {
          "select": [
            "e.id",
            "e.name",
            "e.manager_id",
            { "expression": "ep.path || '\'' -> '\'' || e.name" },
            { "expression": "ep.level + 1" }
          ],
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

### Explanation of Properties:
* **`recursive: true`**: Informs the Query Planner that it must compile a `WITH RECURSIVE` expression.
* **`with[].name`**: Defines the local temporary query table namespace (e.g. `emp_path`).
* **`with[].columns`**: Projected columns exported by the loop steps.
* **`with[].base`**: The entry point/root query of the hierarchy (e.g., manager matches `NULL`).
* **`with[].unionAll`**: The recursive loop joining new records (`e`) back to previously matched parent nodes (`ep`).

---

## 2. API Endpoints

Submit the manifest file (`manifest.json`):

* **Endpoint**: `POST /api/metadata/apply`
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

## 3. Compiled Database Action (Postgres)

```sql
CREATE VIEW "public"."org_hierarchy_recursive" AS
  WITH RECURSIVE emp_path(id, name, manager_id, path, level) AS (
    SELECT id, name, manager_id, name AS path, 1 AS level 
    FROM "public"."employees" 
    WHERE manager_id IS NULL
    UNION ALL
    SELECT e.id, e.name, e.manager_id, ep.path || ' -> ' || e.name, ep.level + 1 
    FROM "public"."employees" e
    INNER JOIN emp_path ep ON e.manager_id = ep.id
  )
  SELECT * FROM emp_path;
```
