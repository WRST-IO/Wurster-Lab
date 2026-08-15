function clone(value) {
  return value == null ? null : structuredClone(value);
}

function sessionId() {
  return `wurst-session-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
}

function attachmentId() {
  return `wurst-attachment-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
}

function relationshipFingerprint(value) {
  return JSON.stringify(value || null);
}

/**
 * One opened Wurst world inside one owning runtime scope.
 *
 * Views and machine clients are ephemeral attachments. They never create a
 * second durable Wurst world and they only remember which shared revision they
 * last observed.
 */
export class WurstSessionRegistry {
  constructor({ now = () => Date.now(), createSessionId = sessionId, createAttachmentId = attachmentId } = {}) {
    this.now = now;
    this.createSessionId = createSessionId;
    this.createAttachmentId = createAttachmentId;
    this.sessions = new Map();
    this.attachments = new Map();
  }

  key(scope, locator) {
    const owner = String(scope ?? '').trim();
    const source = String(locator ?? '').trim();
    if (!owner || !source) throw new TypeError('Wurst session requires a runtime scope and locator');
    return `${owner}\u0000${source}`;
  }

  _public(session) {
    let views = 0, machines = 0;
    for (const attachment of session.attachments.values()) {
      if (attachment.kind === 'view') views += 1;
      else if (attachment.kind === 'machine') machines += 1;
    }
    return Object.freeze({
      format: 'wurst/runtime-session-1',
      id: session.id,
      locator: session.locator,
      revision: session.revision,
      views,
      machines,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      relationship: clone(session.relationship),
      metadata: clone(session.metadata)
    });
  }

  attach(scope, locator, { kind = 'view', relationship = null, metadata = null } = {}) {
    const type = String(kind ?? 'view');
    if (type !== 'view' && type !== 'machine') throw new TypeError('Wurst attachment kind must be "view" or "machine"');
    const key = this.key(scope, locator);
    let session = this.sessions.get(key);
    let created = false;
    if (!session) {
      const now = this.now();
      session = {
        key, id: this.createSessionId(), scope: String(scope), locator: String(locator),
        relationship: clone(relationship), relationshipFingerprint: relationshipFingerprint(relationship),
        metadata: clone(metadata), revision: 0, createdAt: now, updatedAt: now, attachments: new Map()
      };
      this.sessions.set(key, session);
      created = true;
    } else if (session.relationshipFingerprint !== relationshipFingerprint(relationship)) {
      const error = new Error('The same running Wurst cannot have conflicting Parent relationships');
      error.code = 'WURST_SESSION_RELATIONSHIP_CONFLICT';
      throw error;
    }
    const id = this.createAttachmentId();
    const attachment = { id, session, kind: type, baseRevision: session.revision, createdAt: this.now(), metadata: clone(metadata) };
    session.attachments.set(id, attachment);
    this.attachments.set(id, attachment);
    session.updatedAt = this.now();
    return Object.freeze({
      created,
      attachment: Object.freeze({ id, kind: type, baseRevision: attachment.baseRevision }),
      session: this._public(session)
    });
  }

  requireAttachment(rawId) {
    const attachment = this.attachments.get(String(rawId ?? ''));
    if (!attachment) throw new Error('Unknown Wurst session attachment');
    return attachment;
  }

  requireFresh(rawId) {
    const attachment = this.requireAttachment(rawId);
    if (attachment.baseRevision !== attachment.session.revision) {
      const error = new Error(`Wurst session changed from revision ${attachment.baseRevision} to ${attachment.session.revision}`);
      error.code = 'WURST_SESSION_CONFLICT';
      error.session = this._public(attachment.session);
      throw error;
    }
    return attachment;
  }

  refresh(rawId) {
    const attachment = this.requireAttachment(rawId);
    attachment.baseRevision = attachment.session.revision;
    return Object.freeze({
      attachment: Object.freeze({ id: attachment.id, kind: attachment.kind, baseRevision: attachment.baseRevision }),
      session: this._public(attachment.session)
    });
  }

  bump(rawId, { metadata = undefined } = {}) {
    const attachment = this.requireFresh(rawId);
    const session = attachment.session;
    session.revision += 1;
    session.updatedAt = this.now();
    if (metadata !== undefined) session.metadata = clone(metadata);
    attachment.baseRevision = session.revision;
    return this._public(session);
  }

  describeByAttachment(rawId) { return this._public(this.requireAttachment(rawId).session); }

  list(scope = null) {
    const owner = scope == null ? null : String(scope);
    return [...this.sessions.values()]
      .filter((session) => owner == null || session.scope === owner)
      .map((session) => this._public(session))
      .sort((a, b) => a.createdAt - b.createdAt || a.locator.localeCompare(b.locator));
  }

  release(rawId) {
    const attachment = this.requireAttachment(rawId);
    const session = attachment.session;
    session.attachments.delete(attachment.id);
    this.attachments.delete(attachment.id);
    session.updatedAt = this.now();
    const closed = session.attachments.size === 0;
    if (closed) this.sessions.delete(session.key);
    return Object.freeze({ closed, session: this._public(session) });
  }

  releaseScope(scope) {
    const owner = String(scope ?? '');
    const ids = [...this.attachments.values()]
      .filter((attachment) => attachment.session.scope === owner)
      .map((attachment) => attachment.id);
    for (const id of ids) this.release(id);
    return ids.length;
  }
}
