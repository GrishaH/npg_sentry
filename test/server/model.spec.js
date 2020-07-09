'use strict';

const decache = require('decache');
const moment = require('moment');
const MongoClient = require('mongodb').MongoClient;
const fse = require('fs-extra');
const tmp = require('tmp');

let BASE_PORT  = 15000;
let PORT_RANGE = 200;
let PORT = Math.floor(Math.random() * PORT_RANGE) + BASE_PORT;

const constants  = require('../../lib/constants');
const test_utils = require('./test_utils');
const config = require('../../lib/config');

let dbConn;
let model;

let p_db;
let tmpobj;
let tmpdir;

let getCollection = require('./test_utils').getCollection;

describe('model', function() {

  beforeAll(function(done) {
    // setup a mongo instance
    config.provide(() => {console.log('Something 3'); return {mongourl: `mongodb://localhost:${PORT}/test`};});
    model = require('../../lib/model');
    dbConn = require('../../lib/db_conn');
    tmpobj = tmp.dirSync({prefix: 'npg_sentry_test_'});
    tmpdir = tmpobj.name;
    test_utils.start_database(tmpdir, PORT);
    p_db = MongoClient.connect(`mongodb://localhost:${PORT}/test`);
    process.nextTick(p_db.then(done));
  }, 25000);

  afterAll(function(done) {
    test_utils.stop_database(PORT);
    fse.remove(tmpdir, function(err) {
      if (err) {
        console.log(`Error removing ${tmpdir}: ${err}`);
      }
      done();
    });
  });

  describe('DbError', function() {
    it('is a subclass of Error', function() {
      console.log("inside first it");
      let err = new dbConn.DbError('something bad');
      expect(err.name).toBe('DbError');
      expect(err instanceof dbConn.DbError).toBe(true);
      expect(err instanceof Error).toBe(true);
      expect(require('util').isError(err)).toBe(true);
      expect(err.stack).toBeDefined();
      expect(err.toString()).toBe('DbError: something bad');
    });
  });

  describe('mongo connection error', function() {
    beforeAll(function() {
      decache('../../lib/model');
      decache('../../lib/db_conn');
      config.provide(() => {console.log('Something 4'); return {mongourl: `mongodb://invalid:${PORT}/test`};});
      model = require('../../lib/model');
      dbConn = require('../../lib/db_conn');
    });

    afterAll(function() {
      decache('../../lib/model');
      decache('../../lib/db_conn');
      config.provide(() => {return {mongourl: `mongodb://localhost:${PORT}/test`};});
      model = require('../../lib/model');
      dbConn = require('../../lib/db_conn');
    });

    it('is raised', function(done) {
      let user = 'user@example.com';
      let p_insert = model.createToken(user, 'test creation');
      p_insert.catch(function(reason) {
        expect(reason).not.toBeUndefined();
        done();
      });
    });
  });

  describe('exported function', function() {
    beforeEach(function() {
      test_utils.drop_database(PORT);
    });

    describe('createToken', function() {

      [
        {user: 'owner1@example.com', owner: 'owner1@example.com'},
        {user: 'admin@example.com',  owner: 'owner2@example.com'}
      ].forEach(testValues => {
        it(`succeeds for ${JSON.stringify(testValues)}`, function(done) {
          let user  = testValues.user;
          let owner = testValues.owner;

          let p_insert = model.createToken(owner, user, 'test creation');

          let p_collection = p_db.then(getCollection(constants.COLLECTION_TOKENS));

          let p_cursor = p_collection.then(function(collection) {
            return p_insert.then(function() {
              return new Promise(function(resolve, reject) {
                try {
                  resolve(collection.find({user: owner}));
                } catch (err) {
                  fail(err);
                  reject(err);
                }
              });
            });
          });

          let p_count = p_cursor.then(function(cursor) {
            cursor.rewind();
            return cursor.count();
          });

          let p_countExpectation = p_count.then(function(count) {
            expect(count).toBe(1);
          });

          let p_doc = p_cursor.then(function(cursor) {
            cursor.rewind();
            return cursor.next();
          });

          let test_doc = function(doc) {
            expect(doc).toBeDefined();
            expect(doc.user).toBe(owner);
            expect(doc.token).toMatch(/^[a-zA-Z0-9_-]{32}$/gm);
            expect(doc.status).toBe(constants.TOKEN_STATUS_VALID);
            expect(moment(doc.expiryTime).isValid()).toBe(true);
            expect(moment(doc.expiryTime)
              .isBetween(moment().add(7, 'days').subtract(5, 'seconds'), moment().add(7, 'days'))).toBe(true);
            // hist record
            expect(doc.hist).toBeDefined();
            expect(doc.hist.length).toBe(1);
            let hist = doc.hist[0];
            expect(moment(hist.time)
              .isBetween(moment().subtract(5, 'seconds'), moment())).toBe(true);
            expect(hist.operating_user).toBe(user);
            expect(hist.operation).toBe(constants.TOKEN_OPERATION_CREATE);
            expect(hist.reason).toBe('test creation');
          };

          // test document returned by createToken
          let p_insertTest = p_insert.then(test_doc);

          // test document inserted into database
          let p_docExpectation = p_doc.then(test_doc);

          Promise.all([p_countExpectation, p_docExpectation, p_insertTest])
          .then(done, done.fail);
        });
      });

      it('fails with duplicated tokens', function(done) {
        let utils = require('../../lib/token_utils');
        spyOn(
          utils,
          'generateTokenStringPromise'
        ).and.returnValue(Promise.resolve('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'));

        let owner = 'owner@example.com';
        let user  = 'user@example.com';
        let p_insert = model.createToken(owner, user, 'test creation');
        let p_insert2 = p_insert.then(() => {
          expect(utils.generateTokenStringPromise.calls.count()).toEqual(1);
          let secondTokenPromise = model.createToken(owner, user, 'test creation');
          expect(utils.generateTokenStringPromise.calls.count()).toEqual(2);
          return secondTokenPromise;
        }, done.fail);

        p_insert2.then(() => { // second call
          expect(utils.generateTokenStringPromise.calls.count()).toEqual(2);
          done.fail('Second insert should fail but succeeds');
        }, (err) => {
          expect(utils.generateTokenStringPromise.calls.count()).toEqual(2);
          expect(err.toString()).toMatch(/Temporary error, please retry/i);
          let p_collection = p_db.then(getCollection(constants.COLLECTION_TOKENS));

          let p_count = p_collection.then(function(collection) {
            return new Promise(function(resolve, reject) {
              try {
                resolve(
                  collection.find(
                    {user: owner} // user == owner, operating_user == user
                  ).count());
              } catch (err) {
                fail(err);
                reject(err);
              }
            });
          });

          p_count.then(function(count) {
            expect(count).toBe(1);
            done();
          }, done.fail);
        });
      });

      it('rejects with invalid parameters', function(done) {
        let ps = [];

        ps.push(model.createToken().then(function() {
          return Promise.reject('Unexpectedly created token but tokenOwner is not defined');
        }, function (reason) {
          expect(reason).toMatch(/createToken: tokenOwner is not defined/i);
        }));

        ps.push(model.createToken(1).then(function() {
          return Promise.reject('Unexpectedly created token but tokenOwner is not a string');
        }, function (reason) {
          expect(reason).toMatch(/createToken: tokenOwner must be a string/i);
        }));

        ps.push(model.createToken('someOwner').then(function() {
          return Promise.reject('Unexpectedly created token but user is not defined');
        }, function (reason) {
          expect(reason).toMatch(/createToken: user is not defined/i);
        }));

        ps.push(model.createToken('someOwner', 1).then(function() {
          return Promise.reject('Unexpectedly created token but user is not a string');
        }, function (reason) {
          expect(reason).toMatch(/createToken: user must be a string/i);
        }));

        ps.push(model.createToken('someOwner', 'user').then(function() {
          return Promise.reject('Unexpectedly created token but justification is not defined');
        }, function (reason) {
          expect(reason).toMatch(/createToken: justification is not defined/i);
        }));

        ps.push(model.createToken('someOwner', 'user', 1).then(function() {
          return Promise.reject('Unexpectedly created token but justification is not a string');
        }, function (reason) {
          expect(reason).toMatch(/createToken: justification must be a string/i);
        }));

        Promise.all(ps).then(done, done.fail);
      });
    });

    describe('revokeToken', function() {

      it('succeeds on existing token', function(done) {
        let owner = 'owner@example.com';
        let user  = 'user@example.com';
        let token = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

        let p_collection = p_db.then(getCollection(constants.COLLECTION_TOKENS));

        let p_insertion = p_collection.then(function(collection) {
          return collection.insertOne({
            user: owner, token, status: constants.TOKEN_STATUS_VALID, hist: [
              {time: moment().format(), reason: 'insertion to test revokeToken'}
          ]});
        });

        let p_revoke = p_insertion.then(function() {
          return model.revokeToken(owner, user, token, 'Test revocation');
        });

        let p_cursor = p_revoke.then(function() {
          return p_collection.then(function(collection) {
            return collection.find({token});
          });
        });

        let p_doc = p_cursor.then(function(cursor) {
          return cursor.next();
        });

        p_doc.then(function(doc) {
          expect(doc).toBeDefined();
          expect(doc.user).toBe(owner);
          expect(doc.token).toBe(token);
          expect(doc.status).toBe(constants.TOKEN_STATUS_REVOKED);
          // expect token revocation to be second element of list
          expect(doc.hist).toBeDefined();
          expect(doc.hist.length).toBe(2);
          let hist = doc.hist[1];
          expect(moment(hist.time)
            .isBetween(moment().subtract(5, 'seconds'), moment())).toBe(true);
          expect(hist.operating_user).toBe(user);
          expect(hist.operation).toBe(constants.TOKEN_OPERATION_REVOKE);
          expect(hist.reason).toBe('Test revocation');
        }).then(done, done.fail);
      });

      it('rejects with invalid parameters', function(done) {
        let ps = [];

        ps.push(model.revokeToken().then(function() {
          return Promise.reject('Unexpectedly revoked token but tokenOwner is not defined');
        }, function (reason) {
          expect(reason).toMatch(/revokeToken: tokenOwner is not defined/i);
        }));

        ps.push(model.revokeToken(1).then(function() {
          return Promise.reject('Unexpectedly revoked token but tokenOwner is not a string');
        }, function (reason) {
          expect(reason).toMatch(/revokeToken: tokenOwner must be a string/i);
        }));

        ps.push(model.revokeToken('someOwner').then(function() {
          return Promise.reject('Unexpectedly revoked token but user is not defined');
        }, function (reason) {
          expect(reason).toMatch(/revokeToken: user is not defined/i);
        }));

        ps.push(model.revokeToken('someOwner', 1).then(function() {
          return Promise.reject('Unexpectedly revoked token but user is not a string');
        }, function (reason) {
          expect(reason).toMatch(/revokeToken: user must be a string/i);
        }));

        ps.push(model.revokeToken('someOwner', 'user').then(function() {
          return Promise.reject('Unexpectedly revoked token but token is not defined');
        }, function (reason) {
          expect(reason).toMatch(/revokeToken: token is not defined/i);
        }));

        ps.push(model.revokeToken('someOwner', 'user', 1).then(function() {
          return Promise.reject('Unexpectedly revoked token but token is not a string');
        }, function (reason) {
          expect(reason).toMatch(/revokeToken: token must be a string/i);
        }));

        ps.push(model.revokeToken('someOwner', 'user', 'token').then(function() {
          return Promise.reject('Unexpectedly revoked token but justification is not defined');
        }, function (reason) {
          expect(reason).toMatch(/revokeToken: justification is not defined/i);
        }));

        ps.push (model.revokeToken('someOwner', 'user', 'token', 1).then(function() {
          return Promise.reject('Unexpectedly revoked token but justification is not a string');
        }, function (reason) {
          expect(reason).toMatch(/revokeToken: justification must be a string/i);
        }));

        Promise.all(ps).then(done, done.fail);
      });

      it('fails when users do not match', function(done) {
        let tokenOwner    = 'owner@example.com';
        let operatingUser = 'user@example.com';
        let revokingUser  = 'bad@example.com';
        let token         = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

        let p_collection = p_db.then(getCollection(constants.COLLECTION_TOKENS));

        let p_insertion = p_collection.then(function(collection) {
          return collection.insertOne({
            tokenOwner, token, status: constants.TOKEN_STATUS_VALID
          });
        });

        let p_revoke = p_insertion.then(function() {
          return model.revokeToken(revokingUser, operatingUser, token, 'Test revocation');
        });

        p_revoke.then(function() {
          fail('Unexpectedly revoked token but users do not match');
        }, function(reason) {
          expect(reason.message).toEqual(constants.USER_NOT_TOKEN_OWNER);
        }).then(done, done.fail);
      });

      it('fails when token does not exist', function(done) {
        let user = 'user@example.com';
        let token = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

        let p_collection = p_db.then(getCollection(constants.COLLECTION_TOKENS));

        let p_revoke = p_collection.then(function() {
          return model.revokeToken(user, user, token, 'Test revocation');
        });

        p_revoke.then(function() {
          fail('Unexpectedly revoked token but token should not exist');
        }, function(reason) {
          expect(reason instanceof dbConn.DbError).toBe(true);
          expect(reason.message).toBe(
            constants.UNEXPECTED_NUM_DOCS
          );
        }).then(done, done.fail);
      });
    });


    describe('listTokens', function() {

      it('succeeds', function(done) {
        let user = 'user@example.com';
        let token1 = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
        let token2 = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

        let p_collection = p_db.then(getCollection(constants.COLLECTION_TOKENS));

        let p_insertion1 = p_collection.then(function(collection) {
          return collection.insertOne({
            user, token: token1, status: constants.TOKEN_STATUS_VALID
          });
        });

        let p_insertion2 = p_collection.then(function(collection) {
          return collection.insertOne({
            user, token: token2, status: constants.TOKEN_STATUS_VALID
          });
        });

        let p_tokens = Promise.all([p_insertion1, p_insertion2]).then(function() {
          return model.listTokens(user);
        });

        p_tokens.then(function(tokens) {
          expect(tokens instanceof Array).toBe(true);
          let tokenVals = tokens.map(function(row) {
            return row.token;
          });
          expect(tokenVals).toContain(token1);
          expect(tokenVals).toContain(token2);
          let tokenUsers = tokens.every(function(row) {
            return row.user === user;
          });
          expect(tokenUsers).toBe(true);
          let tokensValid = tokens.every(function(row) {
            return row.status === constants.TOKEN_STATUS_VALID;
          });
          expect(tokensValid).toBe(true);
        }).then(done, done.fail);
      });

      it('succeeds despite no tokens', function(done) {
        let user = 'user@example.com';

        let p_collection = p_db.then(getCollection(constants.COLLECTION_TOKENS));

        let p_noTokens = p_collection.then(function() {
          return model.listTokens(user);
        });

        p_noTokens.then(function(tokens) {
          expect(tokens instanceof Array).toBe(true);
          expect(tokens.length).toBe(0);
        }).then(done, done.fail);
      });

      it('rejects with invalid parameters', function(done) {
        let ps = [];

        ps.push(model.listTokens().then(function() {
          return Promise.reject('Unexpectedly listed tokens but user is not defined');
        }, function (reason) {
          expect(reason).toMatch(/listTokens: user is not defined/i);
        }));

        ps.push(model.listTokens(1).then(function() {
          return Promise.reject('Unexpectedly listed tokens but user is not a string');
        }, function (reason) {
          expect(reason).toMatch(/listTokens: user must be a string/i);
        }));

        Promise.all(ps).then(done, done.fail);
      });
    });


    describe('validateUser', function() {

      it('succeeds', function(done) {
        let user = 'user@example.com';
        let reqdGroups = [['1'], ['5']];
        let p_userCollection = p_db.then(getCollection(constants.COLLECTION_USERS));

        let p_userInsertion = p_userCollection.then(function(collection) {
          return collection.insertOne({user, groups: ['1', '2', '5']});
        });

        p_userInsertion.then(function() {
          return model.validateUser(reqdGroups, user);
        }).then(function(result) {
          expect(result).toBe(true);
          done();
        }, done.fail);
      });

      it('successfully returns false', function(done) {
        let user = 'user@example.com';
        let reqdGroups = [['1'], ['5']];

        let p_userCollection = p_db.then(getCollection(constants.COLLECTION_USERS));

        let p_userInsertion = p_userCollection.then(function(collection) {
          return collection.insertOne({user, groups: ['1', '2', '3']});
        });

        p_userInsertion.then(function() {
          return model.validateUser(reqdGroups, user);
        }).then(function(result) {
          expect(result).toBe(false);
          done();
        }, done.fail);
      });

      it ('rejects with invalid parameters', function(done) {
        let ps = [];

        ps.push(model.validateUser().then(function() {
          return Promise.reject('Unexpectedly validated users but groups is not defined');
        }, function (reason) {
          expect(reason).toMatch(/validateUser: resourceGroups is not defined/i);
        }));

        ps.push(model.validateUser(1).then(function() {
          return Promise.reject('Unexpectedly validated users but groups is not an Array');
        }, function (reason) {
          expect(reason).toMatch(/validateUser: resourceGroups must be an Array/i);
        }));

        ps.push(model.validateUser([['a_group']]).then(function() {
          return Promise.reject('Unexpectedly validated users but user is not defined');
        }, function (reason) {
          expect(reason).toMatch(/validateUser: user is not defined/i);
        }));

        ps.push(model.validateUser([['a_group']], 1).then(function() {
          return Promise.reject('Unexpectedly validated users but user is not a string');
        }, function (reason) {
          expect(reason).toMatch(/validateUser: user must be a string/i);
        }));

        Promise.all(ps).then(done, done.fail);
      });

      it('fails when user is multiple times in database', function (done) {
        let user = 'usermultiple@example.com';

        let p_userCollection = p_db.then(getCollection(constants.COLLECTION_USERS));

        let p_userInsertion = p_userCollection.then(function(collection) {
          return collection.insert([
            {user, groups: ['1', '2', '3']},
            {user, groups: ['4', '5', '6']},
          ]);
        });

        p_userInsertion.then(function() {
          let reqdGroups = [['1'], ['5']];
          model.validateUser(reqdGroups, user).then(function() {
            done.fail('Validate user should have failed but succeded');
          }, function(reason) {
            expect(reason instanceof dbConn.DbError).toBe(true);
            console.log(constants.MULTIPLE_DOCS_ERROR);
            expect(reason.message).toBe(constants.MULTIPLE_DOCS_ERROR);
            done();
          });
        }, done.fail);
      });

      it('fails when user does not exist', function(done) {
        let user = 'user@example.com';
        let reqdGroups = [['1'], ['5']];

        model.validateUser(reqdGroups, user).then(function(authorized) {
          expect(authorized).toBe(false);
          done();
        }, function(reason) {
          done.fail(reason);
        });
      });

      it('successfully returns false when groups field is missing', function(done) {
        let user = 'nogroups@example.com';
        let reqdGroups = [['1'], ['5']];

        let p_userCollection = p_db.then(getCollection('users'));

        let p_userInsertion = p_userCollection.then(function(collection) {
          return collection.insertOne({user});
        });

        p_userInsertion.then(function() {
          return model.validateUser(reqdGroups, user);
        }).then(function(result) {
          expect(result).toBe(false);
          done();
        }, done.fail);
      });

      it('successfully returns false when groups field is empty', function(done) {
        let user = 'emptygroups@example.com';
        let reqdGroups = [['1'], ['5']];

        let p_userCollection = p_db.then(getCollection('users'));

        let p_userInsertion = p_userCollection.then(function(collection) {
          return collection.insertOne({user, groups: []});
        });

        p_userInsertion.then(function() {
          return model.validateUser(reqdGroups, user);
        }).then(function(result) {
          expect(result).toBe(false);
          done();
        }, done.fail);
      });
    });

    describe('validateToken', function() {

      it('succeeds', function(done) {
        let user = 'user@example.com';
        let token = 'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';
        let reqdGroups = [['1'], ['5']];

        let p_tokenCollection = p_db.then(getCollection(constants.COLLECTION_TOKENS));

        let p_tokenInsertion = p_tokenCollection.then(function(collection) {
          return collection.insertOne({
            user, token, status: constants.TOKEN_STATUS_VALID
          });
        });

        let p_userCollection = p_db.then(getCollection(constants.COLLECTION_USERS));

        let p_userInsertion = p_userCollection.then(function(collection) {
          return collection.insertOne({user, groups: ['1', '2', '5']});
        });

        let p_result =
          Promise.all([p_tokenInsertion, p_userInsertion])
          .then(function() {
            return model.validateToken(reqdGroups, token);
          });

        p_result.then(function(result) {
          expect(result).toBe(true);
          done();
        }, done.fail);
      });

      it('successfully returns false', function(done) {
        let user = 'user@example.com';
        let token = 'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';
        let reqdGroups = [['1'], ['5']];

        let p_tokenCollection = p_db.then(getCollection(constants.COLLECTION_TOKENS));

        let p_tokenInsertion = p_tokenCollection.then(function(collection) {
          return collection.insertOne({
            user, token, status: constants.TOKEN_STATUS_VALID
          });
        });

        let p_userCollection = p_db.then(getCollection(constants.COLLECTION_USERS));

        let p_userInsertion = p_userCollection.then(function(collection) {
          return collection.insertOne({user, groups: ['1', '2', '3']});
        });

        let p_result =
          Promise.all([p_tokenInsertion, p_userInsertion])
          .then(function() {
            return model.validateToken(reqdGroups, token);
          });

        p_result.then(function(result) {
          expect(result).toBe(false);
          done();
        }, done.fail);
      });

      it('rejects with invalid parameters', function(done) {
        let ps = [];

        ps.push(model.validateToken().then(function() {
          return Promise.reject('Unexpectedly validated tokens but groups is not defined');
        }, function (reason) {
          expect(reason).toMatch(/validateToken: groups is not defined/i);
        }));

        ps.push(model.validateToken(1).then(function() {
          return Promise.reject('Unexpectedly validated tokens but groups is not an Array');
        }, function (reason) {
          expect(reason).toMatch(/validateToken: groups must be an Array/i);
        }));

        ps.push(model.validateToken([['a_group']]).then(function() {
          return Promise.reject('Unexpectedly validated tokens but token is not defined');
        }, function (reason) {
          expect(reason).toMatch(/validateToken: token is not defined/i);
        }));

        ps.push(model.validateToken([['a_group']], 1).then(function() {
          return Promise.reject('Unexpectedly validated tokens but token is not a string');
        }, function (reason) {
          expect(reason).toMatch(/validateToken: token must be a string/i);
        }));

        Promise.all(ps).then(done, done.fail);
      });

      it('fails when token does not exist', function(done) {
        let user = 'user@example.com';
        let token = 'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';
        let reqdGroups = ['1', '2', '3'];

        let p_userCollection = p_db.then(getCollection(constants.COLLECTION_USERS));

        let p_userInsertion = p_userCollection.then(function(collection) {
          return collection.insertOne({user, groups: reqdGroups});
        });

        let p_result = p_userInsertion.then(function() {
          return model.validateToken(reqdGroups, token);
        });

        p_result.then(function() {
          done.fail('Validate token should have failed but succeded');
        }, function(reason) {
          expect(reason instanceof dbConn.DbError).toBe(true);
          expect(reason.message).toBe(
            constants.UNEXPECTED_NUM_DOCS
          );
          done();
        });
      });

      it('successfully returns false when token has been revoked', function(done) {
        let user = 'revoked@example.com';
        let token = 'GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG';
        let reqdGroups = ['1', '5'];

        let p_tokenCollection = p_db.then(getCollection('tokens'));

        let p_tokenInsertion = p_tokenCollection.then(function(collection) {
          return collection.insertOne({
            user, token, status: constants.TOKEN_STATUS_REVOKED
          });
        });

        let p_userCollection = p_db.then(getCollection('users'));

        let p_userInsertion = p_userCollection.then(function(collection) {
          return collection.insertOne({user, groups: ['1', '2', '5']});
        });

        let p_result = Promise.all([p_tokenInsertion, p_userInsertion])
          .then(function() {
            return model.validateToken(reqdGroups, token);
          });

        p_result.then(function(result) {
          expect(result).toBe(false);
          done();
        }, done.fail);
      });

      it('successfully returns false when token has expired', function(done) {
        let user = 'revoked@example.com';
        let token = 'HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH';
        let reqdGroups = ['1', '5'];
        let expiryTime = moment(0).toISOString(); // 1 Jan 1970

        let p_tokenCollection = p_db.then(getCollection('tokens'));

        let p_tokenInsertion = p_tokenCollection.then(function(collection) {
          return collection.insertOne({
            user, token, status: constants.TOKEN_STATUS_VALID, expiryTime
          });
        });

        let p_userCollection = p_db.then(getCollection('users'));

        let p_userInsertion = p_userCollection.then(function(collection) {
          return collection.insertOne({user, groups: ['1', '2', '5']});
        });

        let p_result = Promise.all([p_tokenInsertion, p_userInsertion])
          .then(function() {
            return model.validateToken(reqdGroups, token);
          });

        p_result.then(function(result) {
          expect(result).toBe(false);
          done();
        }, done.fail);
      });
    });
  });

});
