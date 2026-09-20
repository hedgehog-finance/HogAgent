// GENERATED from contracts/*.schema.json by contracts/generate-runtime.mjs. Do not edit.
export const AgentResultContract = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://ciweiai.com/contracts/agent-result.schema.json",
  "title": "Hedgehog structured agent result protocol",
  "oneOf": [
    {
      "$ref": "#/$defs/longTaskGroupResult"
    },
    {
      "$ref": "#/$defs/subAgentResult"
    },
    {
      "$ref": "#/$defs/deliveryDecision"
    },
    {
      "$ref": "#/$defs/deliveryEnvelope"
    }
  ],
  "$defs": {
    "deliveryPath": {
      "type": "string",
      "minLength": 1,
      "pattern": "^(?![\\\\/])(?![A-Za-z]:)(?!.*(?:^|[\\\\/])\\.\\.(?:[\\\\/]|$))(?!.*(?:^|[\\\\/])\\.hedgehog(?:[\\\\/]|$))(?!.*[\\\\/]$).+$"
    },
    "longTaskGroupResult": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "schema_version",
        "type",
        "summary",
        "content",
        "output_files",
        "notes_for_next_group"
      ],
      "properties": {
        "schema_version": {
          "const": "1.0"
        },
        "type": {
          "const": "long_task_group_result"
        },
        "summary": {
          "type": "string"
        },
        "content": {
          "type": "string"
        },
        "output_files": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          }
        },
        "notes_for_next_group": {
          "type": "string",
          "maxLength": 2000
        }
      }
    },
    "subAgentResult": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "schema_version",
        "type",
        "summary",
        "content",
        "output_files"
      ],
      "properties": {
        "schema_version": {
          "const": "1.0"
        },
        "type": {
          "const": "sub_agent_result"
        },
        "summary": {
          "type": "string"
        },
        "content": {
          "type": "string"
        },
        "output_files": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          }
        }
      }
    },
    "deliveryDecision": {
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "schema_version",
            "type",
            "mode"
          ],
          "properties": {
            "schema_version": {
              "const": "1.0"
            },
            "type": {
              "const": "delivery_decision"
            },
            "mode": {
              "enum": [
                "none",
                "deliverables",
                "raw_data"
              ]
            }
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "schema_version",
            "type",
            "mode",
            "files"
          ],
          "properties": {
            "schema_version": {
              "const": "1.0"
            },
            "type": {
              "const": "delivery_decision"
            },
            "mode": {
              "const": "selected_files"
            },
            "files": {
              "type": "array",
              "minItems": 1,
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "path"
                ],
                "properties": {
                  "path": {
                    "$ref": "#/$defs/deliveryPath"
                  },
                  "summary": {
                    "type": "string"
                  }
                }
              }
            }
          }
        }
      ]
    },
    "deliveryEnvelope": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "schema_version",
        "type",
        "files"
      ],
      "properties": {
        "schema_version": {
          "const": "1.0"
        },
        "type": {
          "const": "delivery_files"
        },
        "files": {
          "type": "array",
          "minItems": 1,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "path"
            ],
            "properties": {
              "path": {
                "$ref": "#/$defs/deliveryPath"
              },
              "summary": {
                "type": "string"
              }
            }
          }
        }
      }
    }
  }
} as const;

export const ArtifactManifestContract = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://ciweiai.com/contracts/artifact-manifest.schema.json",
  "title": "Hedgehog artifact manifest protocol",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schema_version",
    "manifest_type",
    "revision",
    "run_id",
    "producer",
    "owner",
    "generated_at",
    "artifacts",
    "changes",
    "integrity"
  ],
  "properties": {
    "schema_version": {
      "const": "1.0"
    },
    "manifest_type": {
      "enum": [
        "session",
        "project"
      ]
    },
    "revision": {
      "type": "integer",
      "minimum": 1
    },
    "session_id": {
      "type": "string",
      "minLength": 1
    },
    "run_id": {
      "type": "string",
      "minLength": 1
    },
    "task_id": {
      "type": "string",
      "minLength": 1
    },
    "project_id": {
      "type": "string",
      "minLength": 1
    },
    "producer": {
      "type": "string",
      "minLength": 1
    },
    "owner": {
      "enum": [
        "agent",
        "gateway"
      ]
    },
    "generated_at": {
      "type": "string",
      "format": "date-time"
    },
    "artifacts": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/artifact"
      }
    },
    "changes": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/change"
      }
    },
    "integrity": {
      "$ref": "#/$defs/integrity"
    }
  },
  "allOf": [
    {
      "if": {
        "properties": {
          "manifest_type": {
            "const": "session"
          }
        }
      },
      "then": {
        "properties": {
          "artifacts": {
            "items": {
              "properties": {
                "root": {
                  "const": "session"
                }
              }
            }
          }
        }
      }
    },
    {
      "if": {
        "properties": {
          "manifest_type": {
            "const": "project"
          }
        }
      },
      "then": {
        "properties": {
          "artifacts": {
            "items": {
              "properties": {
                "root": {
                  "const": "project"
                }
              }
            }
          }
        }
      }
    }
  ],
  "$defs": {
    "role": {
      "enum": [
        "intermediate",
        "raw_data",
        "regular",
        "deliverable"
      ]
    },
    "access": {
      "enum": [
        "none",
        "delivery_event",
        "project_api"
      ]
    },
    "artifactPath": {
      "type": "string",
      "minLength": 1,
      "pattern": "^(?!/)(?![A-Za-z]:/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*(?:^|/)\\.hedgehog(?:/|$)).+$"
    },
    "origin": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "type"
      ],
      "properties": {
        "type": {
          "enum": [
            "web_fetch",
            "web_search",
            "api",
            "upload",
            "database",
            "other"
          ]
        },
        "tool": {
          "type": "string",
          "minLength": 1
        },
        "fetched_at": {
          "type": "string",
          "format": "date-time"
        },
        "locator": {
          "type": "string",
          "format": "uri",
          "pattern": "^https?://[^?#]+$"
        },
        "title": {
          "type": "string"
        },
        "content_type": {
          "type": "string"
        },
        "data_range": {
          "type": "string"
        }
      }
    },
    "artifact": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "path",
        "root",
        "area",
        "role",
        "access",
        "state",
        "version",
        "size",
        "modified_at"
      ],
      "properties": {
        "path": {
          "$ref": "#/$defs/artifactPath"
        },
        "root": {
          "enum": [
            "session",
            "project"
          ]
        },
        "area": {
          "enum": [
            "task",
            "publish",
            "src",
            "data"
          ]
        },
        "role": {
          "$ref": "#/$defs/role"
        },
        "access": {
          "$ref": "#/$defs/access"
        },
        "state": {
          "enum": [
            "current",
            "superseded"
          ]
        },
        "version": {
          "type": "integer",
          "minimum": 1
        },
        "supersedes": {
          "$ref": "#/$defs/artifactPath"
        },
        "size": {
          "type": "integer",
          "minimum": 0
        },
        "modified_at": {
          "type": "string",
          "format": "date-time"
        },
        "sha256": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "origin": {
          "$ref": "#/$defs/origin"
        }
      }
    },
    "change": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "path",
        "operation",
        "role",
        "access"
      ],
      "properties": {
        "path": {
          "$ref": "#/$defs/artifactPath"
        },
        "operation": {
          "enum": [
            "created",
            "modified_in_place",
            "version_created",
            "deleted"
          ]
        },
        "role": {
          "$ref": "#/$defs/role"
        },
        "access": {
          "$ref": "#/$defs/access"
        },
        "previous_path": {
          "$ref": "#/$defs/artifactPath"
        }
      }
    },
    "integrity": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "status",
        "warnings"
      ],
      "properties": {
        "status": {
          "enum": [
            "ok",
            "warning"
          ]
        },
        "warnings": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    }
  }
} as const;

export const ArtifactRunPolicyContract = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://ciweiai.com/contracts/artifact-run-policy.schema.json",
  "title": "Hedgehog run-scoped artifact policy",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schema_version",
    "delivery",
    "mutation"
  ],
  "$defs": {
    "artifactPath": {
      "type": "string",
      "minLength": 1,
      "pattern": "^(?![\\\\/])(?![A-Za-z]:)(?!.*(?:^|[\\\\/])\\.\\.(?:[\\\\/]|$))(?!.*(?:^|[\\\\/])\\.hedgehog(?:[\\\\/]|$))(?!.*[\\\\/]$).+$"
    }
  },
  "properties": {
    "schema_version": {
      "const": "1.0"
    },
    "delivery": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "mode",
        "locked",
        "source",
        "files"
      ],
      "properties": {
        "mode": {
          "enum": [
            "none",
            "deliverables",
            "raw_data",
            "selected_files"
          ]
        },
        "locked": {
          "type": "boolean"
        },
        "source": {
          "enum": [
            "system_default",
            "user_protocol"
          ]
        },
        "files": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/artifactPath"
          }
        }
      },
      "allOf": [
        {
          "if": {
            "properties": {
              "mode": {
                "const": "selected_files"
              }
            }
          },
          "then": {
            "properties": {
              "files": {
                "minItems": 1
              }
            }
          },
          "else": {
            "properties": {
              "files": {
                "maxItems": 0
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "source": {
                "const": "user_protocol"
              }
            }
          },
          "then": {
            "properties": {
              "locked": {
                "const": true
              }
            }
          },
          "else": {
            "properties": {
              "locked": {
                "const": false
              }
            }
          }
        }
      ]
    },
    "mutation": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "mode",
        "locked",
        "source"
      ],
      "properties": {
        "mode": {
          "enum": [
            "contextual",
            "in_place",
            "new_version"
          ]
        },
        "locked": {
          "type": "boolean"
        },
        "source": {
          "enum": [
            "system_default",
            "user_protocol"
          ]
        }
      },
      "allOf": [
        {
          "if": {
            "properties": {
              "source": {
                "const": "user_protocol"
              }
            }
          },
          "then": {
            "properties": {
              "locked": {
                "const": true
              },
              "mode": {
                "enum": [
                  "in_place",
                  "new_version"
                ]
              }
            }
          },
          "else": {
            "properties": {
              "locked": {
                "const": false
              }
            }
          }
        }
      ]
    }
  }
} as const;
