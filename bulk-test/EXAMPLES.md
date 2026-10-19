# Advanced Analytics Examples — AST

Hand-crafted real-world business queries over a retail star schema across **four engines** (Postgres `orders`, MongoDB `customers`, MySQL `products`, Elasticsearch `webviews`). Each shows the fabric **AST** that is executed — validated against a JS oracle in `examples_ast_sql.js`, with per-leg execution checked by `analyze_legs.js`. Write-side concepts (CRUD, sequences, custom functions, write-value generators) are in `suite_crud_functions.js`.

Run: `cd backend && NODE_PATH=./node_modules node ../bulk-test/examples_ast_sql.js`

| # | Scenario | Engines |
|---|---|---|
| 1 | Monthly revenue trend (completed orders) | PG |
| 2 | Top 5 highest-value orders | PG |
| 3 | Rank all orders by amount (ROW_NUMBER window) | PG |
| 4 | RANK orders within product #10 by amount (PARTITION BY) | PG |
| 5 | Median order amount (percentile_cont 0.5) | PG |
| 6 | CTE — monthly count of high-value (amount>=200) orders | PG |
| 7 | Non-equi join — orders exceeding a product base price | PG×MySQL |
| 8 | Distinct active customers (completed orders) | PG |
| 9 | Customers per region | Mongo |
| 10 | Products per category with avg price | MySQL |
| 11 | Revenue by product category | PG×MySQL |
| 12 | Top 5 customers by revenue | PG×Mongo |
| 13 | Average order value (AOV) by region | PG×Mongo |
| 14 | RFM per customer (recency/frequency/monetary) | PG×Mongo |
| 15 | Category revenue by region (3-way join) | PG×MySQL×Mongo |
| 16 | Customers with > 5 completed orders (HAVING) | PG×Mongo |
| 17 | Cohort revenue by customer signup month | PG×Mongo |
| 18 | EAST-region customers who ordered (INTERSECT, cross-engine) | PG∩Mongo |
| 19 | Web views by channel | ES |
| 20 | Revenue by acquisition channel (orders × ES web views) | PG×ES |
| 21 | Months with revenue > 500 (CTE + filter on aggregate) | PG |
| 22 | Distinct customers & products (CTE + COUNT DISTINCT) | PG |
| 23 | Nested CTE chain — monthly count of high-value orders | PG |

---

## 1. Monthly revenue trend (completed orders)

**Engines:** PG

**AST**
```json
{
  "from": {
    "resource": "orders",
    "source": "PG_DSN_Source"
  },
  "select": [
    "order_month",
    {
      "aggregate": "SUM",
      "column": "amount",
      "alias": "revenue"
    }
  ],
  "where": [
    {
      "column": "status",
      "operator": "EQ",
      "value": "COMPLETED"
    }
  ],
  "groupBy": [
    "order_month"
  ],
  "orderBy": [
    {
      "column": "order_month",
      "direction": "ASC"
    }
  ]
}
```

## 2. Top 5 highest-value orders

**Engines:** PG

**AST**
```json
{
  "from": {
    "resource": "orders",
    "source": "PG_DSN_Source"
  },
  "select": [
    "order_id",
    "amount"
  ],
  "where": [
    {
      "column": "order_id",
      "operator": "GT",
      "value": 0
    }
  ],
  "orderBy": [
    {
      "column": "amount",
      "direction": "DESC"
    },
    {
      "column": "order_id",
      "direction": "ASC"
    }
  ],
  "limit": 5
}
```

## 3. Rank all orders by amount (ROW_NUMBER window)

**Engines:** PG · window (in-fabric)

**AST**
```json
{
  "from": {
    "resource": "orders",
    "source": "PG_DSN_Source"
  },
  "select": [
    "order_id",
    "amount",
    {
      "window": "ROW_NUMBER",
      "orderBy": [
        {
          "column": "amount",
          "direction": "DESC"
        }
      ],
      "alias": "rnk"
    }
  ],
  "where": [
    {
      "column": "order_id",
      "operator": "GT",
      "value": 0
    }
  ],
  "limit": 200
}
```

## 4. RANK orders within product #10 by amount (PARTITION BY)

**Engines:** PG · window (in-fabric)

**AST**
```json
{
  "from": {
    "resource": "orders",
    "source": "PG_DSN_Source"
  },
  "select": [
    "order_id",
    "amount",
    {
      "window": "RANK",
      "partitionBy": [
        "product_id"
      ],
      "orderBy": [
        {
          "column": "amount",
          "direction": "DESC"
        }
      ],
      "alias": "rnk"
    }
  ],
  "where": [
    {
      "column": "product_id",
      "operator": "EQ",
      "value": 10
    }
  ],
  "limit": 50
}
```

## 5. Median order amount (percentile_cont 0.5)

**Engines:** PG

**AST**
```json
{
  "from": {
    "resource": "orders",
    "source": "PG_DSN_Source"
  },
  "select": [
    {
      "aggregate": "PERCENTILE",
      "column": "amount",
      "percent": 50,
      "alias": "median"
    }
  ]
}
```

## 6. CTE — monthly count of high-value (amount>=200) orders

**Engines:** PG

**AST**
```json
{
  "with": [
    {
      "name": "hv",
      "columns": [
        "order_id",
        "order_month"
      ],
      "base": {
        "from": {
          "resource": "orders",
          "source": "PG_DSN_Source"
        },
        "select": [
          "order_id",
          "order_month"
        ],
        "where": [
          {
            "column": "amount",
            "operator": "GTE",
            "value": 200
          }
        ]
      }
    }
  ],
  "from": {
    "resource": "hv"
  },
  "select": [
    "order_month",
    {
      "aggregate": "COUNT",
      "column": "*",
      "alias": "n"
    }
  ],
  "groupBy": [
    "order_month"
  ],
  "orderBy": [
    {
      "column": "order_month",
      "direction": "ASC"
    }
  ]
}
```

## 7. Non-equi join — orders exceeding a product base price

**Engines:** PG×MySQL (cross-datasource → `CROSS_ENGINE`)

**AST**
```json
{
  "from": {
    "resource": "orders",
    "source": "PG_DSN_Source",
    "alias": "o"
  },
  "joins": [
    {
      "type": "INNER",
      "resource": "products",
      "source": "Local_MySQL",
      "alias": "p",
      "on": {
        "left": "o.amount",
        "operator": "GT",
        "right": "p.price"
      }
    }
  ],
  "select": [
    {
      "aggregate": "COUNT",
      "column": "*",
      "alias": "n"
    }
  ],
  "where": [
    {
      "column": "o.order_id",
      "operator": "GT",
      "value": 0
    }
  ]
}
```

## 8. Distinct active customers (completed orders)

**Engines:** PG

**AST**
```json
{
  "from": {
    "resource": "orders",
    "source": "PG_DSN_Source"
  },
  "select": [
    "customer_id"
  ],
  "distinct": true,
  "where": [
    {
      "column": "status",
      "operator": "EQ",
      "value": "COMPLETED"
    }
  ],
  "orderBy": [
    {
      "column": "customer_id",
      "direction": "ASC"
    }
  ],
  "limit": 100
}
```

## 9. Customers per region

**Engines:** Mongo

**AST**
```json
{
  "from": {
    "resource": "customers",
    "source": "Local_Mongo"
  },
  "select": [
    "region",
    {
      "aggregate": "COUNT",
      "column": "*",
      "alias": "n"
    }
  ],
  "groupBy": [
    "region"
  ],
  "orderBy": [
    {
      "column": "region",
      "direction": "ASC"
    }
  ]
}
```

## 10. Products per category with avg price

**Engines:** MySQL

**AST**
```json
{
  "from": {
    "resource": "products",
    "source": "Local_MySQL"
  },
  "select": [
    "category",
    {
      "aggregate": "COUNT",
      "column": "*",
      "alias": "n"
    },
    {
      "aggregate": "AVG",
      "column": "price",
      "alias": "avg_price"
    }
  ],
  "groupBy": [
    "category"
  ],
  "orderBy": [
    {
      "column": "category",
      "direction": "ASC"
    }
  ]
}
```

## 11. Revenue by product category

**Engines:** PG×MySQL (cross-datasource → `CROSS_ENGINE`)

**AST**
```json
{
  "from": {
    "resource": "orders",
    "source": "PG_DSN_Source",
    "alias": "o"
  },
  "joins": [
    {
      "type": "INNER",
      "resource": "products",
      "source": "Local_MySQL",
      "alias": "p",
      "on": {
        "left": "o.product_id",
        "operator": "EQ",
        "right": "p.product_id"
      }
    }
  ],
  "select": [
    "p.category",
    {
      "aggregate": "SUM",
      "column": "o.amount",
      "alias": "revenue"
    }
  ],
  "where": [
    {
      "column": "o.status",
      "operator": "EQ",
      "value": "COMPLETED"
    }
  ],
  "groupBy": [
    "p.category"
  ],
  "orderBy": [
    {
      "column": "p.category",
      "direction": "ASC"
    }
  ]
}
```

## 12. Top 5 customers by revenue

**Engines:** PG×Mongo (cross-datasource → `CROSS_ENGINE`)

**AST**
```json
{
  "from": {
    "resource": "orders",
    "source": "PG_DSN_Source",
    "alias": "o"
  },
  "joins": [
    {
      "type": "INNER",
      "resource": "customers",
      "source": "Local_Mongo",
      "alias": "c",
      "on": {
        "left": "o.customer_id",
        "operator": "EQ",
        "right": "c.customer_id"
      }
    }
  ],
  "select": [
    "c.customer_id",
    {
      "aggregate": "SUM",
      "column": "o.amount",
      "alias": "revenue"
    }
  ],
  "where": [
    {
      "column": "o.status",
      "operator": "EQ",
      "value": "COMPLETED"
    }
  ],
  "groupBy": [
    "c.customer_id"
  ],
  "orderBy": [
    {
      "column": "revenue",
      "direction": "DESC"
    }
  ],
  "limit": 5
}
```

## 13. Average order value (AOV) by region

**Engines:** PG×Mongo (cross-datasource → `CROSS_ENGINE`)

**AST**
```json
{
  "from": {
    "resource": "orders",
    "source": "PG_DSN_Source",
    "alias": "o"
  },
  "joins": [
    {
      "type": "INNER",
      "resource": "customers",
      "source": "Local_Mongo",
      "alias": "c",
      "on": {
        "left": "o.customer_id",
        "operator": "EQ",
        "right": "c.customer_id"
      }
    }
  ],
  "select": [
    "c.region",
    {
      "aggregate": "AVG",
      "column": "o.amount",
      "alias": "aov"
    }
  ],
  "where": [
    {
      "column": "o.order_id",
      "operator": "GT",
      "value": 0
    }
  ],
  "groupBy": [
    "c.region"
  ],
  "orderBy": [
    {
      "column": "c.region",
      "direction": "ASC"
    }
  ]
}
```

## 14. RFM per customer (recency/frequency/monetary)

**Engines:** PG×Mongo (cross-datasource → `CROSS_ENGINE`)

**AST**
```json
{
  "from": {
    "resource": "orders",
    "source": "PG_DSN_Source",
    "alias": "o"
  },
  "joins": [
    {
      "type": "INNER",
      "resource": "customers",
      "source": "Local_Mongo",
      "alias": "c",
      "on": {
        "left": "o.customer_id",
        "operator": "EQ",
        "right": "c.customer_id"
      }
    }
  ],
  "select": [
    "c.customer_id",
    {
      "aggregate": "MAX",
      "column": "o.order_month",
      "alias": "recency"
    },
    {
      "aggregate": "COUNT",
      "column": "*",
      "alias": "frequency"
    },
    {
      "aggregate": "SUM",
      "column": "o.amount",
      "alias": "monetary"
    }
  ],
  "where": [
    {
      "column": "o.status",
      "operator": "EQ",
      "value": "COMPLETED"
    }
  ],
  "groupBy": [
    "c.customer_id"
  ],
  "orderBy": [
    {
      "column": "c.customer_id",
      "direction": "ASC"
    }
  ]
}
```

## 15. Category revenue by region (3-way join)

**Engines:** PG×MySQL×Mongo (cross-datasource → `CROSS_ENGINE`)

**AST**
```json
{
  "from": {
    "resource": "orders",
    "source": "PG_DSN_Source",
    "alias": "o"
  },
  "joins": [
    {
      "type": "INNER",
      "resource": "products",
      "source": "Local_MySQL",
      "alias": "p",
      "on": {
        "left": "o.product_id",
        "operator": "EQ",
        "right": "p.product_id"
      }
    },
    {
      "type": "INNER",
      "resource": "customers",
      "source": "Local_Mongo",
      "alias": "c",
      "on": {
        "left": "o.customer_id",
        "operator": "EQ",
        "right": "c.customer_id"
      }
    }
  ],
  "select": [
    "p.category",
    "c.region",
    {
      "aggregate": "SUM",
      "column": "o.amount",
      "alias": "revenue"
    }
  ],
  "where": [
    {
      "column": "o.status",
      "operator": "EQ",
      "value": "COMPLETED"
    }
  ],
  "groupBy": [
    "p.category",
    "c.region"
  ],
  "orderBy": [
    {
      "column": "p.category",
      "direction": "ASC"
    },
    {
      "column": "c.region",
      "direction": "ASC"
    }
  ]
}
```

## 16. Customers with > 5 completed orders (HAVING)

**Engines:** PG×Mongo (cross-datasource → `CROSS_ENGINE`)

**AST**
```json
{
  "from": {
    "resource": "orders",
    "source": "PG_DSN_Source",
    "alias": "o"
  },
  "joins": [
    {
      "type": "INNER",
      "resource": "customers",
      "source": "Local_Mongo",
      "alias": "c",
      "on": {
        "left": "o.customer_id",
        "operator": "EQ",
        "right": "c.customer_id"
      }
    }
  ],
  "select": [
    "c.customer_id",
    {
      "aggregate": "COUNT",
      "column": "*",
      "alias": "n"
    }
  ],
  "where": [
    {
      "column": "o.status",
      "operator": "EQ",
      "value": "COMPLETED"
    }
  ],
  "groupBy": [
    "c.customer_id"
  ],
  "having": [
    {
      "column": "n",
      "operator": "GT",
      "value": 5
    }
  ],
  "orderBy": [
    {
      "column": "c.customer_id",
      "direction": "ASC"
    }
  ]
}
```

## 17. Cohort revenue by customer signup month

**Engines:** PG×Mongo (cross-datasource → `CROSS_ENGINE`)

**AST**
```json
{
  "from": {
    "resource": "orders",
    "source": "PG_DSN_Source",
    "alias": "o"
  },
  "joins": [
    {
      "type": "INNER",
      "resource": "customers",
      "source": "Local_Mongo",
      "alias": "c",
      "on": {
        "left": "o.customer_id",
        "operator": "EQ",
        "right": "c.customer_id"
      }
    }
  ],
  "select": [
    "c.signup_month",
    {
      "aggregate": "SUM",
      "column": "o.amount",
      "alias": "revenue"
    }
  ],
  "where": [
    {
      "column": "o.status",
      "operator": "EQ",
      "value": "COMPLETED"
    }
  ],
  "groupBy": [
    "c.signup_month"
  ],
  "orderBy": [
    {
      "column": "c.signup_month",
      "direction": "ASC"
    }
  ]
}
```

## 18. EAST-region customers who ordered (INTERSECT, cross-engine)

**Engines:** PG∩Mongo (cross-datasource → `CROSS_ENGINE`)

**AST**
```json
{
  "intersect": [
    {
      "from": {
        "resource": "orders",
        "source": "PG_DSN_Source"
      },
      "select": [
        "customer_id"
      ],
      "where": [
        {
          "column": "status",
          "operator": "EQ",
          "value": "COMPLETED"
        }
      ]
    },
    {
      "from": {
        "resource": "customers",
        "source": "Local_Mongo"
      },
      "select": [
        "customer_id"
      ],
      "where": [
        {
          "column": "region",
          "operator": "EQ",
          "value": "EAST"
        }
      ]
    }
  ],
  "limit": 100
}
```

## 19. Web views by channel

**Engines:** ES

**AST**
```json
{
  "from": {
    "resource": "webviews",
    "source": "Local_ES"
  },
  "select": [
    "channel",
    {
      "aggregate": "SUM",
      "column": "views",
      "alias": "v"
    }
  ],
  "groupBy": [
    "channel"
  ],
  "orderBy": [
    {
      "column": "channel",
      "direction": "ASC"
    }
  ]
}
```

## 20. Revenue by acquisition channel (orders × ES web views)

**Engines:** PG×ES (cross-datasource → `CROSS_ENGINE`)

**AST**
```json
{
  "from": {
    "resource": "orders",
    "source": "PG_DSN_Source",
    "alias": "o"
  },
  "joins": [
    {
      "type": "INNER",
      "resource": "webviews",
      "source": "Local_ES",
      "alias": "w",
      "on": {
        "left": "o.customer_id",
        "operator": "EQ",
        "right": "w.customer_id"
      }
    }
  ],
  "select": [
    "w.channel",
    {
      "aggregate": "SUM",
      "column": "o.amount",
      "alias": "revenue"
    }
  ],
  "where": [
    {
      "column": "o.status",
      "operator": "EQ",
      "value": "COMPLETED"
    }
  ],
  "groupBy": [
    "w.channel"
  ],
  "orderBy": [
    {
      "column": "w.channel",
      "direction": "ASC"
    }
  ]
}
```

## 21. Months with revenue > 500 (CTE + filter on aggregate)

**Engines:** PG

**AST**
```json
{
  "with": [
    {
      "name": "monthly",
      "columns": [
        "order_month",
        "rev"
      ],
      "base": {
        "from": {
          "resource": "orders",
          "source": "PG_DSN_Source"
        },
        "select": [
          "order_month",
          {
            "aggregate": "SUM",
            "column": "amount",
            "alias": "rev"
          }
        ],
        "where": [
          {
            "column": "status",
            "operator": "EQ",
            "value": "COMPLETED"
          }
        ],
        "groupBy": [
          "order_month"
        ]
      }
    }
  ],
  "from": {
    "resource": "monthly"
  },
  "select": [
    "order_month",
    "rev"
  ],
  "where": [
    {
      "column": "rev",
      "operator": "GT",
      "value": 500
    }
  ],
  "orderBy": [
    {
      "column": "order_month",
      "direction": "ASC"
    }
  ]
}
```

## 22. Distinct customers & products (CTE + COUNT DISTINCT)

**Engines:** PG

**AST**
```json
{
  "with": [
    {
      "name": "t",
      "columns": [
        "customer_id",
        "product_id"
      ],
      "base": {
        "from": {
          "resource": "orders",
          "source": "PG_DSN_Source"
        },
        "select": [
          "customer_id",
          "product_id"
        ],
        "where": [
          {
            "column": "status",
            "operator": "EQ",
            "value": "COMPLETED"
          }
        ]
      }
    }
  ],
  "from": {
    "resource": "t"
  },
  "select": [
    {
      "aggregate": "COUNT_DISTINCT",
      "column": "customer_id",
      "alias": "custs"
    },
    {
      "aggregate": "COUNT_DISTINCT",
      "column": "product_id",
      "alias": "prods"
    }
  ]
}
```

## 23. Nested CTE chain — monthly count of high-value orders

**Engines:** PG

**AST**
```json
{
  "with": [
    {
      "name": "hv",
      "columns": [
        "customer_id",
        "order_month"
      ],
      "base": {
        "from": {
          "resource": "orders",
          "source": "PG_DSN_Source"
        },
        "select": [
          "customer_id",
          "order_month"
        ],
        "where": [
          {
            "column": "amount",
            "operator": "GTE",
            "value": 200
          }
        ]
      }
    },
    {
      "name": "m",
      "columns": [
        "order_month",
        "n"
      ],
      "base": {
        "from": {
          "resource": "hv"
        },
        "select": [
          "order_month",
          {
            "aggregate": "COUNT",
            "column": "*",
            "alias": "n"
          }
        ],
        "groupBy": [
          "order_month"
        ]
      }
    }
  ],
  "from": {
    "resource": "m"
  },
  "select": [
    "order_month",
    "n"
  ],
  "orderBy": [
    {
      "column": "order_month",
      "direction": "ASC"
    }
  ],
  "limit": 12
}
```
