// Copyright (c) Ville de Montreal. All rights reserved.
// Licensed under the MIT license.
// See LICENSE file in the project root for full license information.

import { Client as CamundaExternalClient } from 'camunda-external-task-client-js';
import * as nock from 'nock';
import * as opentracing from 'opentracing';
import { SERVICE_IDENTIFIER } from '../../config/constants/identifiers';
import { Client } from '../../models/camunda-n-mq/client';
import { IMessage } from '../../models/camunda-n-mq/specs/message';
import { CamundaBpmClient } from '../../models/camunda/camundaBpmClient';
import { ICamundaClient } from '../../models/camunda/specs/camundaClient';
import { ICamundaConfig } from '../../models/camunda/specs/camundaConfig';
import { Utils } from '../../models/camunda/utils';
import { CamundaClientTracer } from '../../models/core/instrumentations/camundaClientTracer';
import { Instrumentation } from '../../models/core/instrumentations/instrumentation';
import { SCProcessHandler } from '../../models/core/processHandler/simpleCamundaProcessHandler';
import { FailureStrategySimple } from '../../models/core/strategies/FailureStrategySimple';
import { SuccessStrategySimple } from '../../models/core/strategies/SuccessStrategySimple';
import { Worker } from '../../models/core/worker';
import { IoC } from '../../models/IoC';
import { FakeTask } from '../utils/fake';
import { run } from '../utils/func-test';

const taskName = 'sample_activity';
let worker: Worker;
let successHandler: SuccessStrategySimple;
let config: ICamundaConfig;
let camundaClient: CamundaBpmClient;
let failureHandler: FailureStrategySimple;
let client: Client<CamundaBpmClient>;
let processHandler: SCProcessHandler;
// tslint:disable:ter-prefer-arrow-callback
// tslint:disable:only-arrow-functions
// tslint:disable:max-func-body-length
describe('Camunda Worker', function() {
  beforeEach(() => {
    config = {
      maxTasks: 1,
      workerId: 'demo',
      baseUrl: `http://localhost:8080/engine-rest`,
      topicName: 'topic_demo',
      bpmnKey: 'BPMN_DEMO',
      autoPoll: false,
      interceptors: Utils.defaultInterceptors()
    };
    // init
    const basicOauth = { username: 'admin', password: 'admin123' };
    IoC.unbind(SERVICE_IDENTIFIER.camunda_oauth_info);
    IoC.bindToObject(basicOauth, SERVICE_IDENTIFIER.camunda_oauth_info);

    const clientLib: ICamundaClient = new CamundaExternalClient(config) as any;
    const noopTracer = new opentracing.Tracer();
    const ccTracer = new CamundaClientTracer(noopTracer);
    const instrumentation = new Instrumentation([ccTracer]);
    camundaClient = new CamundaBpmClient(config, clientLib, instrumentation);
    successHandler = new SuccessStrategySimple();
    failureHandler = new FailureStrategySimple();
    client = new Client(camundaClient);
    processHandler = new SCProcessHandler(successHandler, failureHandler, config as any);

    successHandler.handle = jest.fn().mockResolvedValueOnce({});
    worker = new Worker(client, processHandler);

    // TODO: use IoC for getting worker instance... there is a bug with jest
    // https://github.com/inversify/InversifyJS/issues/997
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('should call the url passed in the ctor', done => {
    const scoped = nock('http://localhost:8080', { encodedQueryParams: true } as any)
      .post('/engine-rest/external-task/fetchAndLock')
      .reply(200, [] as any);

    run(worker, scoped, done);
  });
  it('should have Basic Auth', done => {
    const scoped = nock('http://localhost:8080', { encodedQueryParams: true } as any)
      .post('/engine-rest/external-task/fetchAndLock')
      .reply(function() {
        expect(this.req.headers.authorization).toStrictEqual('Basic YWRtaW46YWRtaW4xMjM=');
      });

    run(worker, scoped, done);
  });
  it('should get the task and send failure to Camunda since no task is bound', done => {
    const scoped = nock('http://localhost:8080')
      .post('/engine-rest/external-task/fetchAndLock')
      .reply(200, () => {
        return require('../data/camunda-response.json');
      })
      .post('/engine-rest/external-task/37a72320-c4c2-11e8-a64b-0242ac110002/failure')
      .reply(204);

    run(worker, scoped, done, 500);
  });

  it('should get the task and send success to Camunda since task is bound', done => {
    const fakeTask = new FakeTask();
    fakeTask.execute = jest.fn().mockResolvedValueOnce({});
    IoC.unbind(taskName);
    IoC.bindToObject(fakeTask, taskName);

    const scoped = nock('http://localhost:8080')
      .post('/engine-rest/external-task/fetchAndLock')
      .reply(200, require('../data/camunda-response.json'));

    worker.start();
    worker.run();

    setTimeout(() => {
      worker.stop().catch();
      expect(fakeTask.execute).toHaveBeenCalled();
      expect(successHandler.handle).toHaveBeenCalled();
      expect(successHandler.handle).toBeCalledTimes(1);
      expect(scoped.isDone()).toBe(true);
      done();
    }, 500);
  });
  it('should execute interceptors', done => {
    const fakeTask = new FakeTask();
    const executeTaskMock: jest.Mock<any> = (fakeTask.execute = jest.fn().mockResolvedValueOnce({}));
    IoC.unbind(taskName);
    IoC.bindToObject(fakeTask, taskName);

    const scoped = nock('http://localhost:8080')
      .post('/engine-rest/external-task/fetchAndLock')
      .reply(200, require('../data/camunda-response.json'));

    const configWithInterceptors = {
      maxTasks: 1,
      baseUrl: `http://localhost:8080/engine-rest`,
      topicName: 'topic_demo',
      interceptors: [
        (message: IMessage): Promise<IMessage> => {
          return Promise.resolve({
            body: null,
            properties: {
              workflowInstanceKey: '38963',
              bpmnProcessId: 'test-process',
              workflowDefinitionVersion: 4,
              workflowKey: '8806',
              activityId: 'ServiceTask_0xdwuw7',
              elementInstanceKey: '38967',
              customHeaders: { basic: 'Basic fake' },
              jobKey: '38968',
              processInstanceId: '38963',
              retries: 1,
              lockExpirationTime: new Date(),
              topicName: 'topic_demo',
              workerId: 'demo'
            },
            spans: new opentracing.Span()
          });
        },
        (message: IMessage): Promise<IMessage> => {
          return Promise.resolve({
            body: null,
            properties: {
              workflowInstanceKey: '38963',
              bpmnProcessId: 'test-process',
              workflowDefinitionVersion: 4,
              workflowKey: '8806',
              activityId: 'ServiceTask_0xdwuw7',
              elementInstanceKey: '38967',
              customHeaders: { jwt: 'jwt fake' },
              jobKey: '38968',
              processInstanceId: '38963',
              retries: 1,
              lockExpirationTime: new Date(),
              topicName: 'topic_demo',
              workerId: 'demo'
            },
            spans: new opentracing.Span()
          });
        }
      ],
      autoPoll: false
    };
    const newProcessHandler = new SCProcessHandler(successHandler, failureHandler, configWithInterceptors);
    worker = new Worker(client, newProcessHandler);
    worker.start();
    worker.run();

    setTimeout(() => {
      worker.stop().catch();
      const message = executeTaskMock.mock.calls[0][0] as IMessage;

      expect(fakeTask.execute).toHaveBeenCalled();
      expect(successHandler.handle).toHaveBeenCalled();
      expect(successHandler.handle).toBeCalledTimes(1);
      expect(scoped.isDone()).toBe(true);
      expect(message.properties.customHeaders.jwt).toStrictEqual('jwt fake');
      expect(message.properties.customHeaders.basic).not.toStrictEqual('Basic fake');
      done();
    }, 700);
  });
  it('should execute interceptors', async () => {
    nock('http://localhost:8080')
      .post('/engine-rest/external-task/fetchAndLock')
      .reply(200, require('../data/camunda-response.json'));

    worker = new Worker(client, processHandler);
    worker.start();
    worker.run();
    await expect(worker.stop()).resolves.toBeUndefined();
    worker.run();
    setTimeout(
      async _work => {
        await expect(_work.stop()).resolves.toBeUndefined();
      },
      700,
      worker
    );
  });
});
