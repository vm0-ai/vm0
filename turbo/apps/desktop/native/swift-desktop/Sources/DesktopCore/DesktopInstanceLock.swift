import Foundation

#if canImport(Darwin)
  import Darwin
#else
  import Glibc
#endif

/// The file stays in place; removing a locked inode could admit two owners.
/// The kernel releases ownership on normal exit or a crash, and CLOEXEC keeps
/// helper processes from inheriting the application's lock.
public final class DesktopInstanceLock {
  private let descriptor: Int32
  private init(_ descriptor: Int32) { self.descriptor = descriptor }
  deinit { close(descriptor) }

  public static func acquire(at file: URL) throws -> DesktopInstanceLock? {
    let descriptor = open(file.path, O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0o600)
    guard descriptor >= 0 else {
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    if flock(descriptor, LOCK_EX | LOCK_NB) == 0 { return DesktopInstanceLock(descriptor) }
    let failure = errno
    close(descriptor)
    if failure == EWOULDBLOCK { return nil }
    throw NSError(domain: NSPOSIXErrorDomain, code: Int(failure))
  }
}
