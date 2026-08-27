export const SESSION_MESSAGING_CONTRACT_MAJOR = 1 as const;

export type DeliveryIntent = 'notify' | 'wake';
export type DeliveryClass = 'PUSH' | 'TURN_BOUNDARY' | 'POLL' | 'OFFLINE';

export type SessionIdentity = {
  engineerId: string;
  harness: string;
  projectId?: string;
  instanceId: string;
};

export type Envelope = {
  contractMajor: typeof SESSION_MESSAGING_CONTRACT_MAJOR;
  messageId: string;
  messageType: string;
  payload: unknown;
  sender: SessionIdentity;
  recipient: SessionIdentity;
  correlationId: string;
  causationId?: string;
  replyTo?: string;
  requestedIntent: DeliveryIntent;
};

type VerificationState = 'verified' | 'degraded' | 'unverified';

type EvidenceMetadata = {
  harness: string;
  surface: string;
  harnessVersion: string;
  os: string;
  observedDate: string;
  mechanism: string;
  result: string;
  evidencePointer: string;
  notes?: string;
  degradationThreshold: number;
};

export type SessionCapabilities = {
  contractMajor: typeof SESSION_MESSAGING_CONTRACT_MAJOR;
  session: SessionIdentity;
  effectiveDeliveryClass: DeliveryClass;
  supportedIntents: DeliveryIntent[];
  ingressKind: string;
  verifiedAt: string;
  verifiedBy: 'probe' | 'traffic';
  lastAckAt?: string;
  verificationState: VerificationState;
  consecutiveExpectedObservationFailures: number;
  degradationReason?: string;
  evidence: EvidenceMetadata;
};

type Downgrade = {
  from: 'wake';
  to: 'notify';
  reason: string;
};

type ReceiptIntent =
  | { requestedIntent: 'notify'; effectiveIntent: 'notify'; downgrade?: never }
  | { requestedIntent: 'wake'; effectiveIntent: 'wake'; downgrade?: never }
  | { requestedIntent: 'wake'; effectiveIntent: 'notify'; downgrade: Downgrade };

type BusReaction = {
  kind: 'ack' | 'reply' | 'decline' | 'other';
  messageId: string;
};

type ReceiptOutcome =
  | {
      outcome: 'accepted' | 'routed' | 'surfaced';
      busReaction?: never;
      declineReason?: never;
    }
  | {
      outcome: 'handled';
      busReaction: BusReaction;
      declineReason?: never;
    }
  | {
      outcome: 'declined';
      declineReason: string;
      busReaction?: never;
      downgrade?: never;
    };

export type DeliveryReceipt = {
  contractMajor: typeof SESSION_MESSAGING_CONTRACT_MAJOR;
  messageId: string;
  correlationId: string;
  observedAt: string;
} & ReceiptIntent &
  ReceiptOutcome;

type EffectiveCapability = {
  deliveryClass: DeliveryClass;
  supportedIntents: DeliveryIntent[];
  ingressKind: string;
};

export type ProbeResult = {
  contractMajor: typeof SESSION_MESSAGING_CONTRACT_MAJOR;
  session: SessionIdentity;
  trigger: 'registration' | 'reconnect';
  mechanism: string;
  outcome: string;
  observedAt: string;
  effectiveCapability: EffectiveCapability;
  verificationState: VerificationState;
  evidence: EvidenceMetadata;
};

const nonEmptyString = { type: 'string', minLength: 1 } as const;
const timestamp = {
  type: 'string',
  format: 'date-time',
} as const;

export const sessionMessagingSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:create-agent-rig:session-messaging:v1',
  title: 'Session Messaging Contract v0, major v1',
  $defs: {
    ContractMajor: {
      type: 'integer',
      const: SESSION_MESSAGING_CONTRACT_MAJOR,
    },
    VerificationState: {
      type: 'string',
      enum: ['verified', 'degraded', 'unverified'],
    },
    EvidenceMetadata: {
      type: 'object',
      required: [
        'harness',
        'surface',
        'harnessVersion',
        'os',
        'observedDate',
        'mechanism',
        'result',
        'evidencePointer',
        'degradationThreshold',
      ],
      properties: {
        harness: nonEmptyString,
        surface: nonEmptyString,
        harnessVersion: nonEmptyString,
        os: nonEmptyString,
        observedDate: {
          type: 'string',
          format: 'date',
        },
        mechanism: nonEmptyString,
        result: nonEmptyString,
        evidencePointer: nonEmptyString,
        notes: nonEmptyString,
        degradationThreshold: {
          type: 'integer',
          minimum: 1,
        },
      },
      additionalProperties: false,
    },
    Downgrade: {
      type: 'object',
      required: ['from', 'to', 'reason'],
      properties: {
        from: { const: 'wake' },
        to: { const: 'notify' },
        reason: nonEmptyString,
      },
      additionalProperties: false,
    },
    BusReaction: {
      type: 'object',
      required: ['kind', 'messageId'],
      properties: {
        kind: {
          type: 'string',
          enum: ['ack', 'reply', 'decline', 'other'],
        },
        messageId: nonEmptyString,
      },
      additionalProperties: false,
    },
    EffectiveCapability: {
      type: 'object',
      required: ['deliveryClass', 'supportedIntents', 'ingressKind'],
      properties: {
        deliveryClass: { $ref: '#/$defs/DeliveryClass' },
        supportedIntents: {
          type: 'array',
          items: { $ref: '#/$defs/DeliveryIntent' },
          minItems: 1,
          uniqueItems: true,
        },
        ingressKind: nonEmptyString,
      },
      additionalProperties: false,
    },
    SessionIdentity: {
      type: 'object',
      required: ['engineerId', 'harness', 'instanceId'],
      properties: {
        engineerId: nonEmptyString,
        harness: nonEmptyString,
        projectId: nonEmptyString,
        instanceId: nonEmptyString,
      },
      additionalProperties: false,
    },
    Envelope: {
      type: 'object',
      required: [
        'contractMajor',
        'messageId',
        'messageType',
        'payload',
        'sender',
        'recipient',
        'correlationId',
        'requestedIntent',
      ],
      properties: {
        contractMajor: { $ref: '#/$defs/ContractMajor' },
        messageId: nonEmptyString,
        messageType: nonEmptyString,
        payload: true,
        sender: { $ref: '#/$defs/SessionIdentity' },
        recipient: { $ref: '#/$defs/SessionIdentity' },
        correlationId: nonEmptyString,
        causationId: nonEmptyString,
        replyTo: nonEmptyString,
        requestedIntent: { $ref: '#/$defs/DeliveryIntent' },
      },
      additionalProperties: false,
    },
    DeliveryIntent: {
      type: 'string',
      enum: ['notify', 'wake'],
    },
    DeliveryClass: {
      type: 'string',
      enum: ['PUSH', 'TURN_BOUNDARY', 'POLL', 'OFFLINE'],
    },
    SessionCapabilities: {
      type: 'object',
      required: [
        'contractMajor',
        'session',
        'effectiveDeliveryClass',
        'supportedIntents',
        'ingressKind',
        'verifiedAt',
        'verifiedBy',
        'verificationState',
        'consecutiveExpectedObservationFailures',
        'evidence',
      ],
      properties: {
        contractMajor: { $ref: '#/$defs/ContractMajor' },
        session: { $ref: '#/$defs/SessionIdentity' },
        effectiveDeliveryClass: { $ref: '#/$defs/DeliveryClass' },
        supportedIntents: {
          type: 'array',
          items: { $ref: '#/$defs/DeliveryIntent' },
          minItems: 1,
          uniqueItems: true,
        },
        ingressKind: nonEmptyString,
        verifiedAt: timestamp,
        verifiedBy: {
          type: 'string',
          enum: ['probe', 'traffic'],
        },
        lastAckAt: timestamp,
        verificationState: { $ref: '#/$defs/VerificationState' },
        consecutiveExpectedObservationFailures: {
          type: 'integer',
          minimum: 0,
        },
        degradationReason: nonEmptyString,
        evidence: { $ref: '#/$defs/EvidenceMetadata' },
      },
      allOf: [
        {
          if: {
            properties: { verificationState: { const: 'degraded' } },
            required: ['verificationState'],
          },
          then: {
            properties: {
              degradationReason: nonEmptyString,
              consecutiveExpectedObservationFailures: {
                type: 'integer',
                minimum: 1,
              },
            },
            required: ['degradationReason'],
          },
        },
      ],
      additionalProperties: false,
    },
    DeliveryReceipt: {
      type: 'object',
      required: [
        'contractMajor',
        'messageId',
        'correlationId',
        'observedAt',
        'requestedIntent',
        'effectiveIntent',
        'outcome',
      ],
      properties: {
        contractMajor: { $ref: '#/$defs/ContractMajor' },
        messageId: nonEmptyString,
        correlationId: nonEmptyString,
        observedAt: timestamp,
        requestedIntent: { $ref: '#/$defs/DeliveryIntent' },
        effectiveIntent: { $ref: '#/$defs/DeliveryIntent' },
        outcome: {
          type: 'string',
          enum: ['accepted', 'routed', 'surfaced', 'handled', 'declined'],
        },
        downgrade: { $ref: '#/$defs/Downgrade' },
        declineReason: nonEmptyString,
        busReaction: { $ref: '#/$defs/BusReaction' },
      },
      allOf: [
        {
          if: {
            properties: { outcome: { const: 'handled' } },
            required: ['outcome'],
          },
          then: {
            properties: { busReaction: { $ref: '#/$defs/BusReaction' } },
            required: ['busReaction'],
          },
          else: {
            not: {
              properties: { busReaction: {} },
              required: ['busReaction'],
            },
          },
        },
        {
          if: {
            properties: { outcome: { const: 'declined' } },
            required: ['outcome'],
          },
          then: {
            properties: {
              declineReason: nonEmptyString,
              downgrade: false,
            },
            required: ['declineReason'],
          },
          else: {
            not: {
              properties: { declineReason: {} },
              required: ['declineReason'],
            },
          },
        },
        {
          if: {
            properties: { downgrade: { $ref: '#/$defs/Downgrade' } },
            required: ['downgrade'],
          },
          then: {
            properties: {
              requestedIntent: { const: 'wake' },
              effectiveIntent: { const: 'notify' },
            },
          },
        },
        {
          if: {
            properties: {
              requestedIntent: { const: 'wake' },
              effectiveIntent: { const: 'notify' },
            },
            required: ['requestedIntent', 'effectiveIntent'],
          },
          then: {
            properties: { downgrade: { $ref: '#/$defs/Downgrade' } },
            required: ['downgrade'],
          },
        },
        {
          if: {
            properties: { requestedIntent: { const: 'notify' } },
            required: ['requestedIntent'],
          },
          then: {
            properties: { effectiveIntent: { const: 'notify' } },
          },
        },
      ],
      additionalProperties: false,
    },
    ProbeResult: {
      type: 'object',
      required: [
        'contractMajor',
        'session',
        'trigger',
        'mechanism',
        'outcome',
        'observedAt',
        'effectiveCapability',
        'verificationState',
        'evidence',
      ],
      properties: {
        contractMajor: { $ref: '#/$defs/ContractMajor' },
        session: { $ref: '#/$defs/SessionIdentity' },
        trigger: {
          type: 'string',
          enum: ['registration', 'reconnect'],
        },
        mechanism: nonEmptyString,
        outcome: nonEmptyString,
        observedAt: timestamp,
        effectiveCapability: { $ref: '#/$defs/EffectiveCapability' },
        verificationState: { $ref: '#/$defs/VerificationState' },
        evidence: { $ref: '#/$defs/EvidenceMetadata' },
      },
      additionalProperties: false,
    },
  },
} as const;

export type SessionMessagingSchema = typeof sessionMessagingSchema;
