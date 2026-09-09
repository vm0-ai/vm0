#import <AppKit/AppKit.h>
#include <string.h>
#include <unistd.h>

@interface DiscoveryFixture : NSObject <NSApplicationDelegate>
@end

@implementation DiscoveryFixture
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  (void)notification;
  NSURL *directory = NSBundle.mainBundle.bundleURL.URLByDeletingLastPathComponent;
  NSURL *marker = [directory URLByAppendingPathComponent:@"fixture-running.json"];
  NSDictionary *identity = @{@"pid": @(getpid()),
                             @"bundleId": NSBundle.mainBundle.bundleIdentifier};
  NSData *data = [NSJSONSerialization dataWithJSONObject:identity options:0 error:nil];
  if (![data writeToURL:marker atomically:YES]) {
    [NSApp terminate:nil];
    return;
  }
  NSURL *stop = [directory URLByAppendingPathComponent:@"fixture-stop"];
  NSDate *expiry = [NSDate dateWithTimeIntervalSinceNow:90];
  [NSTimer scheduledTimerWithTimeInterval:0.05 repeats:YES block:^(NSTimer *timer) {
    if ([NSFileManager.defaultManager fileExistsAtPath:stop.path] ||
        expiry.timeIntervalSinceNow <= 0) {
      [timer invalidate];
      [NSApp terminate:nil];
    }
  }];
}
@end

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc == 2 && strcmp(argv[1], "--running") == 0) {
      NSMutableArray *pids = [NSMutableArray array];
      for (NSRunningApplication *candidate in
           [NSRunningApplication runningApplicationsWithBundleIdentifier:
               NSBundle.mainBundle.bundleIdentifier]) {
        if (!candidate.terminated && candidate.processIdentifier != getpid()) {
          [pids addObject:@(candidate.processIdentifier)];
        }
      }
      NSData *data = [NSJSONSerialization dataWithJSONObject:pids options:0 error:nil];
      puts([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
      return 0;
    }
    NSApplication *application = NSApplication.sharedApplication;
    [application setActivationPolicy:NSApplicationActivationPolicyRegular];
    static DiscoveryFixture *delegate;
    delegate = [DiscoveryFixture new];
    application.delegate = delegate;
    [application run];
  }
  return 0;
}
