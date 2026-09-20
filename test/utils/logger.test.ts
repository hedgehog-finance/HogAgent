import { logger, setLogLevel, getLogLevel, createLogger } from "../../src/utils/logger.ts";

describe("logger module", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stderrSpy: any;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as any);
    setLogLevel("debug"); // Allow all levels for testing
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    setLogLevel("info"); // Reset to default
  });

  describe("log level filtering", () => {
    it("should log messages at or above current level", () => {
      setLogLevel("info");
      logger.info("test", "info message");
      expect(stderrSpy).toHaveBeenCalledTimes(1);
    });

    it("should filter messages below current level", () => {
      setLogLevel("warn");
      logger.debug("test", "debug message");
      logger.info("test", "info message");
      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it("should allow warn and error when level is warn", () => {
      setLogLevel("warn");
      logger.warn("test", "warning");
      logger.error("test", "error");
      expect(stderrSpy).toHaveBeenCalledTimes(2);
    });

    it("should only allow error when level is error", () => {
      setLogLevel("error");
      logger.debug("test", "debug");
      logger.info("test", "info");
      logger.warn("test", "warn");
      logger.error("test", "error");
      expect(stderrSpy).toHaveBeenCalledTimes(1);
    });

    it("should allow all levels when level is debug", () => {
      setLogLevel("debug");
      logger.debug("test", "debug");
      logger.info("test", "info");
      logger.warn("test", "warn");
      logger.error("test", "error");
      expect(stderrSpy).toHaveBeenCalledTimes(4);
    });
  });

  describe("structured output format", () => {
    it("should output valid JSON", () => {
      logger.info("test-ctx", "test message");
      const output = stderrSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output.trim());
      expect(parsed).toBeDefined();
    });

    it("should include ts, level, ctx, and msg fields", () => {
      logger.info("my-context", "hello world");
      const output = stderrSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output.trim());
      expect(parsed.ts).toBeDefined();
      expect(parsed.level).toBe("info");
      expect(parsed.ctx).toBe("my-context");
      expect(parsed.msg).toBe("hello world");
    });

    it("should include data field when provided", () => {
      logger.info("ctx", "msg", { key: "value", num: 42 });
      const output = stderrSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output.trim());
      expect(parsed.data).toEqual({ key: "value", num: 42 });
    });

    it("should not include data field when not provided", () => {
      logger.info("ctx", "msg");
      const output = stderrSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output.trim());
      expect(parsed.data).toBeUndefined();
    });

    it("should not include data field when empty object", () => {
      logger.info("ctx", "msg", {});
      const output = stderrSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output.trim());
      expect(parsed.data).toBeUndefined();
    });
  });

  describe("context tagging", () => {
    it("should include the context in output", () => {
      logger.warn("rpc-handler", "connection issue");
      const output = stderrSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output.trim());
      expect(parsed.ctx).toBe("rpc-handler");
    });
  });

  describe("output goes to stderr", () => {
    it("should write to stderr, not stdout", () => {
      const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      logger.info("test", "message");
      expect(stderrSpy).toHaveBeenCalled();
      expect(stdoutSpy).not.toHaveBeenCalled();
      stdoutSpy.mockRestore();
    });
  });

  describe("createLogger", () => {
    it("should create a child logger bound to a context", () => {
      const log = createLogger("my-module");
      log.info("hello");
      const output = stderrSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output.trim());
      expect(parsed.ctx).toBe("my-module");
      expect(parsed.msg).toBe("hello");
    });

    it("should support all log levels", () => {
      const log = createLogger("module");
      log.debug("d");
      log.info("i");
      log.warn("w");
      log.error("e");
      expect(stderrSpy).toHaveBeenCalledTimes(4);
    });
  });

  describe("getLogLevel / setLogLevel", () => {
    it("should get and set the log level", () => {
      setLogLevel("error");
      expect(getLogLevel()).toBe("error");
      setLogLevel("debug");
      expect(getLogLevel()).toBe("debug");
    });
  });
});
