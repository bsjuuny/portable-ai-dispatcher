import { describe, expect, it } from 'vitest';
import { parseStructuredSpecification, buildTaskSpecification } from '../../src/task/task-specification.js';

const REAL_WORLD_REPORT = `
로그인 API 호출 시 다음 오류가 발생한다.

ERR-USER-1042

java.lang.NullPointerException:
Cannot invoke User.getId() because user is null

at com.example.service.UserService.findUser(UserService.java:128)
at com.example.controller.UserController.login(UserController.java:74)

재현 조건:

1. 신규 회원 가입
2. 이메일 인증 전 로그인
3. POST /api/login 호출

요구사항:

- 기존 API 변경 금지
- 정상 로그인 회귀 오류 금지
- Regression Test 추가
`;

describe('parseStructuredSpecification', () => {
  it('extracts the error code from spec section 16 real-world example', () => {
    const result = parseStructuredSpecification(REAL_WORLD_REPORT);
    expect(result.errorCodes).toContain('ERR-USER-1042');
  });

  it('extracts stack trace lines as a block', () => {
    const result = parseStructuredSpecification(REAL_WORLD_REPORT);
    expect(result.stackTraces).toBeDefined();
    expect(result.stackTraces![0]).toContain('UserService.java:128');
  });

  it('extracts numbered reproduction steps in order', () => {
    const result = parseStructuredSpecification(REAL_WORLD_REPORT);
    expect(result.reproductionSteps).toEqual([
      '신규 회원 가입',
      '이메일 인증 전 로그인',
      'POST /api/login 호출',
    ]);
  });

  it('extracts bulleted requirements', () => {
    const result = parseStructuredSpecification(REAL_WORLD_REPORT);
    expect(result.requirements).toContain('기존 API 변경 금지');
    expect(result.requirements).toContain('Regression Test 추가');
  });

  it('flags requirements containing prohibition keywords as constraints', () => {
    const result = parseStructuredSpecification(REAL_WORLD_REPORT);
    expect(result.constraints).toContain('기존 API 변경 금지');
    expect(result.constraints).not.toContain('Regression Test 추가');
  });

  it('returns all-undefined fields for an empty description rather than throwing', () => {
    const result = parseStructuredSpecification('');
    expect(result.errorCodes).toBeUndefined();
    expect(result.requirements).toBeUndefined();
  });

  it('handles a plain one-line description', () => {
    const result = parseStructuredSpecification('로그인 오류를 수정해줘');
    expect(result.summary).toBe('로그인 오류를 수정해줘');
    expect(result.requirements).toBeUndefined();
  });
});

describe('buildTaskSpecification', () => {
  it('always preserves rawDescription verbatim regardless of structured extraction (spec section 21)', () => {
    const spec = buildTaskSpecification({ rawDescription: REAL_WORLD_REPORT });
    expect(spec.rawDescription).toBe(REAL_WORLD_REPORT);
  });

  it('starts with an empty attachments array that the caller populates later', () => {
    const spec = buildTaskSpecification({ rawDescription: 'hello' });
    expect(spec.attachments).toEqual([]);
  });
});
