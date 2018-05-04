import 'mocha'
import { Connection } from '../src/connection'
import { DataAndMoneyStream } from '../src/stream'
import * as index from '../src/index'
import MockPlugin from './mocks/plugin'
import * as sinon from 'sinon'
import * as Chai from 'chai'
import * as chaiAsPromised from 'chai-as-promised'
Chai.use(chaiAsPromised)
const assert = Object.assign(Chai.assert, sinon.assert)
require('source-map-support').install()

describe('Server', function () {
  beforeEach(function () {
    this.clientPlugin = new MockPlugin(0.5)
    this.serverPlugin = this.clientPlugin.mirror
  })

  describe('generateAddressAndSecret', function () {
    beforeEach(async function () {
      this.server = new index.Server({
        serverSecret: Buffer.alloc(32),
        plugin: this.serverPlugin
      })
    })

    it('should throw an error if the server is not connected', function () {
      const server = new index.Server({
        serverSecret: Buffer.alloc(32),
        plugin: this.serverPlugin
      })

      assert.throws(() => server.generateAddressAndSecret(), 'Server must be connected to generate address and secret')
    })

    it('should return a destinationAccount and sharedSecret', async function () {
      await this.server.listen()

      const result = this.server.generateAddressAndSecret()
      assert(Buffer.isBuffer(result.sharedSecret))
      assert.lengthOf(result.sharedSecret, 32)
      assert.typeOf(result.destinationAccount, 'string')
    })

    it('should accept connections created without connectionTags', async function () {
      await this.server.listen()
      const { destinationAccount, sharedSecret } = this.server.generateAddressAndSecret()
      const connectionPromise = this.server.acceptConnection()

      const clientConn = await index.createConnection({
        plugin: this.clientPlugin,
        destinationAccount,
        sharedSecret
      })

      const connection = await connectionPromise
    })

    it('should accept a connectionTag and attach it to the incoming connection', async function () {
      await this.server.listen()
      const connectionTag = 'hello-there_123'
      const { destinationAccount, sharedSecret } = this.server.generateAddressAndSecret(connectionTag)
      const connectionPromise = this.server.acceptConnection()

      const clientConn = await index.createConnection({
        plugin: this.clientPlugin,
        destinationAccount,
        sharedSecret
      })

      const connection = await connectionPromise
      assert.equal(connection.connectionTag, connectionTag)
    })

    it('should reject the connection if the connectionTag is modified', async function () {
      await this.server.listen()
      const connectionName = 'hello-there_123'
      const { destinationAccount, sharedSecret } = this.server.generateAddressAndSecret(connectionName)

      const spy = sinon.spy()
      this.server.on('connection', spy)

      const realSendData = this.clientPlugin.sendData.bind(this.clientPlugin)
      const responses: Buffer[] = []
      this.clientPlugin.sendData = async (data: Buffer): Promise<Buffer> => {
        const response = await realSendData(data)
        responses.push(response)
        return response
      }

      await assert.isRejected(index.createConnection({
        plugin: this.clientPlugin,
        destinationAccount: destinationAccount + '456',
        sharedSecret
      }), 'Error connecting: Unexpected error while sending packet. Code: F02, message: ')

      assert.notCalled(spy)
    })

    it('should throw an error if the connectionTag includes characters that cannot go into an ILP address', async function () {
      await this.server.listen()
      assert.throws(() => this.server.generateAddressAndSecret('invalid\n'), 'connectionTag can only include ASCII characters a-z, A-Z, 0-9, "_", and "-"')
    })
  })

  describe('"connection" event', function () {
    beforeEach(async function () {
      this.server = new index.Server({
        serverSecret: Buffer.alloc(32),
        plugin: this.serverPlugin
      })
      await this.server.listen()
    })

    it('should not reject the packet if there is an error in the connection event handler', async function () {
      this.server.on('connection', () => {
        throw new Error('blah')
      })

      await index.createConnection({
        ...this.server.generateAddressAndSecret(),
        plugin: this.clientPlugin
      })
    })
  })
})

describe('createServer', function () {
  beforeEach(function () {
    this.clientPlugin = new MockPlugin(0.5)
    this.serverPlugin = this.clientPlugin.mirror
  })

  it('should return a server that is listening', async function () {
    const spy = sinon.spy(this.serverPlugin, 'connect')
    const server = await index.createServer({
      serverSecret: Buffer.alloc(32),
      plugin: this.serverPlugin
    })
    assert.instanceOf(server, index.Server)
    assert.called(spy)
  })
})