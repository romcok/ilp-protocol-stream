import EventEmitter3 = require('eventemitter3')
import * as ILDCP from 'ilp-protocol-ildcp'
import * as IlpPacket from 'ilp-packet'
import * as Debug from 'debug'
import * as cryptoHelper from './crypto'
import { Connection, ConnectionOpts } from './connection'
import { Plugin } from './types'
require('source-map-support').install()

const CONNECTION_ID_REGEX = /^[a-zA-Z0-9_-]+$/

export interface CreateConnectionOpts extends ConnectionOpts {
  /** ILP Address of the server */
  destinationAccount: string,
  /** Shared secret generated by the server */
  sharedSecret: Buffer
}

/**
 * Create a connection to a server using the address and secret provided.
 */
export async function createConnection (opts: CreateConnectionOpts): Promise<Connection> {
  await opts.plugin.connect()
  const sourceAccount = (await ILDCP.fetch(opts.plugin.sendData.bind(opts.plugin))).clientAddress
  const connection = new Connection({
    ...opts,
    sourceAccount,
    isServer: false
  })
  opts.plugin.registerDataHandler(async (data: Buffer): Promise<Buffer> => {
    let prepare: IlpPacket.IlpPrepare
    try {
      prepare = IlpPacket.deserializeIlpPrepare(data)
    } catch (err) {
      this.debug(`got data that is not an ILP Prepare packet: ${data.toString('hex')}`)
      return IlpPacket.serializeIlpReject({
        code: 'F00',
        message: `Expected an ILP Prepare packet (type 12), but got packet with type: ${data[0]}`,
        data: Buffer.alloc(0),
        triggeredBy: sourceAccount
      })
    }

    try {
      const fulfill = await connection.handlePrepare(prepare)
      return IlpPacket.serializeIlpFulfill(fulfill)
    } catch (err) {
      if (!err.ilpErrorCode) {
        this.debug('error handling prepare:', err)
      }
      // TODO should the default be F00 or T00?
      return IlpPacket.serializeIlpReject({
        code: err.ilpErrorCode || 'F00',
        message: err.ilpErrorMessage || '',
        data: err.ilpErrorData || Buffer.alloc(0),
        triggeredBy: sourceAccount
      })
    }
  })
  connection.once('close', () => {
    opts.plugin.deregisterDataHandler()
    opts.plugin.disconnect()
  })
  await connection.connect()
  // TODO resolve only when it is connected
  return connection
}

export interface ServerOpts extends ConnectionOpts {
  serverSecret: Buffer
}

/**
 * ILP STREAM server that can listen on an account and handle multiple incoming connections.
 * Note: the connections this refers to are over ILP, not over the Internet.
 *
 * The server operator should give a unique address and secret (generated by calling
 * `generateAddressAndSecret`) to each client that it expects to connect.
 */
export class Server extends EventEmitter3 {
  protected serverSecret: Buffer
  protected plugin: Plugin
  protected sourceAccount: string
  protected connections: { [key: string]: Connection }
  protected debug: Debug.IDebugger
  protected enablePadding?: boolean
  protected connected: boolean
  protected connectionOpts: ConnectionOpts

  constructor (opts: ServerOpts) {
    super()
    this.serverSecret = opts.serverSecret
    this.plugin = opts.plugin
    this.debug = Debug('ilp-protocol-stream:Server')
    this.connections = {}
    this.connectionOpts = Object.assign({}, opts, {
      serverSecret: undefined
    }) as ConnectionOpts
    this.connected = false
  }

  /**
   * Connect the plugin and start listening for incoming connections.
   *
   * When a new connection is accepted, the server will emit the "connection" event.
   */
  async listen (): Promise<void> {
    if (this.connected && this.plugin.isConnected()) {
      return
    }
    this.plugin.registerDataHandler(this.handleData.bind(this))
    await this.plugin.connect()
    this.sourceAccount = (await ILDCP.fetch(this.plugin.sendData.bind(this.plugin))).clientAddress
    this.connected = true
  }

  /**
   * Resolves when the next connection is accepted.
   *
   * To handle subsequent connections, the user must call `acceptConnection` again.
   */
  async acceptConnection (): Promise<Connection> {
    await this.listen()
    /* tslint:disable-next-line:no-unnecessary-type-assertion */
    return new Promise((resolve, reject) => {
      this.once('connection', resolve)
    }) as Promise<Connection>
  }

  /**
   * Generate an address and secret for a specific client to enable them to create a connection to the server.
   *
   * Two different clients SHOULD NOT be given the same address and secret.
   *
   * @param connectionName Optional connection identifier that will be appended to the ILP address and can be used to identify incoming connections. Can only include characters that can go into an ILP Address
   */
  generateAddressAndSecret (connectionName?: string): { destinationAccount: string, sharedSecret: Buffer } {
    if (!this.connected) {
      throw new Error('Server must be connected to generate address and secret')
    }
    let token = base64url(cryptoHelper.generateToken())
    if (connectionName) {
      if (!CONNECTION_ID_REGEX.test(connectionName)) {
        throw new Error('connectionTag can only include ASCII characters a-z, A-Z, 0-9, "_", and "-"')
      }
      token = token + '~' + connectionName
    }
    const sharedSecret = cryptoHelper.generateSharedSecretFromToken(this.serverSecret, Buffer.from(token, 'ascii'))
    return {
      // TODO should this be called serverAccount or serverAddress instead?
      destinationAccount: `${this.sourceAccount}.${token}`,
      sharedSecret
    }
  }

  protected async handleData (data: Buffer): Promise<Buffer> {
    try {
      let prepare: IlpPacket.IlpPrepare
      try {
        prepare = IlpPacket.deserializeIlpPrepare(data)
      } catch (err) {
        this.debug(`got data that is not an ILP Prepare packet: ${data.toString('hex')}`)
        return IlpPacket.serializeIlpReject({
          code: 'F00',
          message: `Expected an ILP Prepare packet (type 12), but got packet with type: ${data[0]}`,
          data: Buffer.alloc(0),
          triggeredBy: this.sourceAccount
        })
      }

      const localAddressParts = prepare.destination.replace(this.sourceAccount + '.', '').split('.')
      if (localAddressParts.length === 0 || !localAddressParts[0]) {
        this.debug(`destination in ILP Prepare packet does not have a Connection ID: ${prepare.destination}`)
        throw new IlpPacket.Errors.UnreachableError('')
      }
      const connectionId = localAddressParts[0]

      if (!this.connections[connectionId]) {
        let sharedSecret
        try {
          const token = Buffer.from(connectionId, 'ascii')
          sharedSecret = cryptoHelper.generateSharedSecretFromToken(this.serverSecret, token)
          cryptoHelper.decrypt(sharedSecret, prepare.data)
        } catch (err) {
          this.debug(`got prepare for an address and token that we did not generate: ${prepare.destination}`)
          throw new IlpPacket.Errors.UnreachableError('')
        }

        // If we get here, that means it was a token + sharedSecret we created
        const connectionTag = (connectionId.indexOf('~') !== -1 ? connectionId.slice(connectionId.indexOf('~') + 1) : undefined)
        const connection = new Connection({
          ...this.connectionOpts,
          sourceAccount: this.sourceAccount,
          sharedSecret,
          isServer: true,
          connectionTag
        })
        this.connections[connectionId] = connection
        this.debug(`got incoming packet for new connection: ${connectionId}${(connectionTag ? ' (connectionTag: ' + connectionTag + ')' : '')}`)
        try {
          this.emit('connection', connection)
        } catch (err) {
          this.debug('error in connection event handler:', err)
        }

        // Wait for the next tick of the event loop before handling the prepare
        await new Promise((resolve, reject) => setImmediate(resolve))
      }

      const fulfill = await this.connections[connectionId].handlePrepare(prepare)
      return IlpPacket.serializeIlpFulfill(fulfill)

    } catch (err) {
      if (!err.ilpErrorCode) {
        this.debug('error handling prepare:', err)
      }
      // TODO should the default be F00 or T00?
      return IlpPacket.serializeIlpReject({
        code: err.ilpErrorCode || 'F00',
        message: err.ilpErrorMessage || '',
        data: err.ilpErrorData || Buffer.alloc(0),
        triggeredBy: this.sourceAccount || ''
      })
    }
  }
}

function base64url (buffer: Buffer) {
  return buffer.toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}
