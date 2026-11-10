Pod::Spec.new do |s|
  s.name           = 'BookClubNative'
  s.version        = '1.0.0'
  s.summary        = 'Book Club: the widgets\' data, the audiobook\'s Live Activity (D189) and CarPlay (D221)'
  s.description    = 'A local Expo module of the Book Club app: hands the widget extension what to show through the App Group, and starts, updates and ends the Live Activity.'
  s.author         = 'Cole Tebou'
  s.homepage       = 'https://books.badland.ai'
  s.license        = { :type => 'Proprietary' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks     = 'ActivityKit', 'WidgetKit', 'CarPlay', 'WatchConnectivity'
  s.source_files   = '**/*.swift'
end
