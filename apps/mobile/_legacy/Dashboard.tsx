import { Pressable, Text, View } from "react-native";

const presets = [
  { label: "25m Pomodoro" },
  { label: "45m Flow Sprint" },
  { label: "60m Focus Session" },
  { label: "90m Deep Lock" },
];

export function Dashboard() {
  return (
    <View className="flex-1 bg-brand-bg px-6 pb-10 pt-16">
      <View className="mb-10">
        <Text className="text-sm uppercase tracking-widest text-brand-navy/70">
          vibeBalance
        </Text>
        <Text className="mt-2 text-5xl font-bold text-brand-navy">1,250</Text>
      </View>

      <Pressable className="mb-10 rounded-full bg-brand-red px-8 py-7">
        <Text className="text-center text-2xl font-bold text-brand-cream">
          Start Deep Work
        </Text>
      </Pressable>

      <View className="flex-row flex-wrap gap-4">
        {presets.map((preset) => (
          <View
            key={preset.label}
            className="min-h-28 w-[47%] justify-end rounded-4xl bg-brand-navy p-5"
          >
            <Text className="text-lg font-semibold text-brand-cream">{preset.label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}
