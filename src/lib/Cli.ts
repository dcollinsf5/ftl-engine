import * as path from 'path'
import * as fs from 'fs'
import { Readable } from 'stream'
import * as async from 'async'
import * as yargs from 'yargs'
import * as _ from 'lodash'
import * as shortId from 'shortid'

import { Config } from '../Config'
import { ActivityWorker, DeciderWorker } from '../workers'
import { registration, InitedEntities } from '../init'
import { validator } from './validator'
import { Processor, genUtil, MetadataStore } from '../generator'
import { StringToStream } from './StringToStream'

export class Cli {
  config: Config
  activityWorker?: ActivityWorker
  deciderWorker?: DeciderWorker
  cli: yargs.Argv
  constructor() {
  }
  printStack(cli, msg, err) {
    cli.showHelp()
    console.error(msg)
    if (process.env.YARGS_DEBUG) {
      console.error(err.stack)
    }
  }
  run(cb: {(Error?)}): yargs.Argv {
    this.cli = yargs
    .usage('Usage: $0 -c <jsConf> <command> [args...]')
    .demand(1)
    .command('submit <input>', 'submit the file (or - for stdin) as an ftl-engine task', (yargs) => {
    return yargs.reset().option('config', {
        alias: 'c',
        describe: 'js config module to load',
        demand: true,
        string: true
      }).option('id', {
        alias: 'i',
        describe: 'the unique id of the workflow',
        string: true,
        default: shortId.generate()
      }).fail(this.printStack.bind(this, yargs)) as any
    }, this.submit.bind(this, cb))
    .command('start', 'start ftl-engine with specified components', (yargs) => {
      return yargs.reset().option('config', {
        alias: 'c',
        describe: 'js config module to load',
        demand: true,
        string: true
      }).option('activity', {
        alias: 'a',
        description: 'start the activty worker',
        default: true,
        boolean: true,
      }).option('decider', {
        alias: 'd',
        description: 'start the decider worker',
        default: true,
        boolean: true,
      }).fail(this.printStack.bind(this, yargs)) as any
    }, this.start.bind(this, cb))
    .command('generate <directory>', 'generate an ftl task from the directory', (yargs) => {
      return yargs.reset().option('data', {
        alias: 'd',
        description: 'metadata to load on start, either a path to a file or a json string',
        string: true
      }).option('exclude', {
        alias: 'x',
        description: 'exclude a list of top level stages to not process, comma seperated',
        string: true
      }).option('whitelist', {
        alias: 'w',
        description: 'include only a list of top level stages to process, comma seperated (takes precedence over exclude)',
        string: true
      }).option('output', {
        alias: 'o',
        description: 'output location, defaults to stdout',
        string: true,
        default: '-',
        normalize: true
      }).fail(this.printStack.bind(this, yargs)) as any
    }, this.generate.bind(this, cb))
    this.cli.argv
    return this.cli
  }
  submit(cb: {(Error?)}, args: any) {
    this.init(args.config, (err, entities) => {
      if (err) return cb(err)
      const inputFile = args.input
      let {config, workflow} = entities!

      let source: string | null = null
      if (inputFile === '-') {
        source = '/dev/stdin'
      } else {
        source = path.join(path.resolve(process.cwd(), inputFile))
      }

      let workInput: any | null = null
      try {
        workInput = JSON.parse(fs.readFileSync(source).toString())
      } catch (e) {
        return cb(e)
      }
      if (!workInput) {
        return cb(new Error('invalid work input'))
      }

      const failureReason = validator.validate(config, workInput)
      if (failureReason) {
        config.logger.error('invalid job')
        config.logger.error(failureReason)
        return cb(new Error('invalid job'))
      }
      let initialEnv = workInput.env || {}

      workflow.startWorkflow(args.id, workInput, initialEnv, {}, (err, info) => {
        if (err) return cb(err)
        config.logger.info(info)
        cb()
      })
    })
  }
  start(cb: {(Error?)}, args: any) {
    if (!args.activity || !args.decider) {
      console.log('no workers specified, nothing to do')
      this.cli.showHelp()
      return cb()
    }
    this.init(args.config, (err, entities) => {
      if (err) return cb(err)
      this.startWorkers(args, cb)
    })
  }
  init(configFile: string, cb: {(err: Error | null, entities?: InitedEntities )}) {
    const configFunc = require(path.join(process.cwd(), configFile))
    const config = new Config(configFunc)
    this.config = config
    registration.init(config, (err, entities) => {
      if (err) return cb(err)
      this.activityWorker = entities!.activityWorker
      this.deciderWorker = entities!.deciderWorker
      cb(null, entities)
    })
  }
  startWorkers(args: any, cb: {(Error?)}) {
    function toStop(worker: ActivityWorker | DeciderWorker, name: 'activity' | 'decider', cb: {(Error?)}) {
      worker.on('error', (err: Error, execution?: any) => {
        let withExecution = execution ? ` with execution ${execution.id}` : ''
        this.config.logger.fatal(`error from ${name} worker${withExecution}`, {err, execution})
        this.config.notifier.sendError('workerError', {workerName: name, err}, (err) => {
          if (err) this.config.logger.fatal('unable to send notifier alert!', {err})
          return cb(err)
        })
      })
    }
    const workers = {}
    if (args.activity) {
      toStop.call(this, this.activityWorker, 'activity', cb)
      workers['activityWorker'] = this.activityWorker
    }
    if (args.decider) {
      toStop.call(this, this.deciderWorker, 'decider', cb)
      workers['deciderWorker'] = this.deciderWorker
    }
    this.startActivityWorker(args.activity, (err) => {
      if (err) return cb(err)
      this.startDeciderWorker(args.decider, (err) => {
        if (err) return cb(err)
        this.config.logger.info('started workers')
      })
    })
    let gotSigint = false
    process.on('SIGINT', () => {
      if (gotSigint) {
        this.config.logger.warn('forcefully exiting, some tasks may have left an invalid state')
        return process.exit(1)
      }
      this.config.logger.info('signalling workers to exit cleanly, ctrl+c again to immediately exit')
      gotSigint = true
      async.each(Object.keys(workers), (name, cb) => {
        let worker = workers[name]
        worker.stop((err) => {
          if (err) return cb(err)
          this.config.logger.info(`stopped ${name} worker`)
          cb()
        })
      }, cb)
    })
  }
  startActivityWorker(shouldStart: boolean, cb: {(err: Error | null, s: boolean)}) {
    if (!shouldStart) return cb(null, false)
    if (!this.activityWorker) return cb(new Error('init not called'), false)
    this.activityWorker.start((err) => {
      if (err) return cb(err, false)
      this.config.logger.info('started activity worker')
      cb(null, true)
    })
  }
  startDeciderWorker(shouldStart: boolean, cb: {(err: Error | null, s: boolean)}) {
    if (!shouldStart) return cb(null, false)
    if (!this.deciderWorker) return cb(new Error('init not called'), false)
    this.deciderWorker.start((err) => {
      if (err) return cb(err, false)
      this.config.logger.info('started decider worker')
      cb(null, true)
    })
  }
  generate(cb: {(err: Error | null)}, args: any) {

    const outStream = args.output === '-' ? process.stdout : fs.createWriteStream(path.join(process.cwd(), args.output))

    const toRun = path.join(process.cwd(), args.directory)
    let initialMeta = {}
    const exclude: string[] = args.exclude ? args.exclude.split(',') : []
    const whitelist: string[] = args.whitelist ? args.whitelist.split(',') : []
    if (args.data) {
      let isJsonStr = false
      try {
        initialMeta = JSON.parse(args.data)
        isJsonStr = true
      } catch (e) {
      }
      if (!isJsonStr) {
        initialMeta = require(path.join(process.cwd(), args.data))
      }
    }
    genUtil.readDirectory(toRun, function(err, info) {
      if (err) return cb(err)
      if (!info) return cb(new Error('unexpected, missing info'))
      // exclude directories
      if (whitelist.length) {
        info.dirs = whitelist
      } else {
        info.dirs = _.difference(info.dirs, exclude)
      }
      if (err) throw err
      let p = new Processor(new MetadataStore(initialMeta), toRun, info.files, info.dirs)
      p.process({}, function(err, output) {
        if (err) throw err
        const instream = new StringToStream(JSON.stringify(output, null, 2))

        instream.pipe(outStream)
      })
    })
  }
}
