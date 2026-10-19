declare const process: any;
import axios from 'axios';

const API_BASE = 'http://localhost:4000/api';

async function run() {
  console.log('=== Programmatic Flow Verification ===');

  try {
    // 1. Log in
    console.log('1. Attempting login as admin...');
    const loginRes = await axios.post(`${API_BASE}/auth/login`, {
      username: 'admin',
      password: 'admin'
    });
    
    const { token, user } = loginRes.data;
    console.log('   Login successful!');
    console.log(`   User ID: ${user.id}`);
    console.log(`   Tenant ID: ${user.tenant_id}`);
    console.log(`   Role: ${user.role || 'ADMIN'}`);
    
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    };

    // 2. Fetch plans
    console.log('2. Fetching available plans...');
    const plansRes = await axios.get(`${API_BASE}/plans`, { headers });
    const plans = plansRes.data;
    console.log(`   Found ${plans.length} plans.`);
    const trialPlan = plans.find((p: any) => p.name === 'trial');
    const selfhostPlan = plans.find((p: any) => p.name === 'selfhost');
    
    console.log(`   Trial Plan ID: ${trialPlan?.id}`);
    console.log(`   Self-Host Plan ID: ${selfhostPlan?.id}`);

    // 2b. Test Plan Customization (Admin only)
    if (trialPlan) {
      console.log(`2b. Testing plan customization for Trial Plan (${trialPlan.id})...`);
      const originalDescription = trialPlan.features?.description || '';
      
      const updatePlanRes = await axios.put(`${API_BASE}/plans/${trialPlan.id}`, {
        name: 'trial',
        price_monthly: 0.00,
        limits: trialPlan.limits,
        features: {
          ...trialPlan.features,
          description: 'Updated trial plan text'
        }
      }, { headers });
      
      console.log('   Plan updated status in response:', updatePlanRes.data.features?.description);
      if (updatePlanRes.data.features?.description === 'Updated trial plan text') {
        console.log('   ✔ Plan customization successfully verified!');
      } else {
        throw new Error('Plan features description mismatch after update');
      }

      // Revert plan customization
      await axios.put(`${API_BASE}/plans/${trialPlan.id}`, {
        name: 'trial',
        price_monthly: 0.00,
        limits: trialPlan.limits,
        features: {
          ...trialPlan.features,
          description: originalDescription
        }
      }, { headers });
      console.log('   Plan customization reverted.');
    }

    // 3. Fetch current subscription
    console.log('3. Fetching current active subscription...');
    const subRes = await axios.get(`${API_BASE}/subscriptions/me`, { headers });
    console.log('   Current subscription:', subRes.data);

    // 4. Activate Self-Host Plan
    if (selfhostPlan) {
      console.log(`4. Activating Self-Host Plan (${selfhostPlan.id})...`);
      const actRes = await axios.post(`${API_BASE}/subscriptions/me`, {
        plan_id: selfhostPlan.id,
        status: 'active'
      }, { headers });
      console.log('   Plan activated successfully:', actRes.data);

      // Verify subscription updated
      console.log('5. Verifying active subscription update...');
      const subUpdatedRes = await axios.get(`${API_BASE}/subscriptions/me`, { headers });
      console.log('   Updated subscription plan name:', subUpdatedRes.data.plan_name);
      if (subUpdatedRes.data.plan_id === selfhostPlan.id) {
        console.log('   ✔ Subscription successfully updated in database!');
      } else {
        throw new Error('Subscription ID mismatch after update');
      }
    }

    // 5. List tenants
    console.log('6. Listing user tenants...');
    const tenantsRes = await axios.get(`${API_BASE}/tenants`, { headers });
    console.log(`   Found ${tenantsRes.data.length} tenants owned/accessible.`);

    // 6. Create a new tenant with user-specified ID
    const testTenantId = `t_test_script_${Date.now().toString(36)}`;
    console.log(`7. Deploying new tenant namespace with ID: ${testTenantId}...`);
    const createRes = await axios.post(`${API_BASE}/tenants`, {
      id: testTenantId,
      name: 'Verification Test Workspace'
    }, { headers });
    console.log('   Tenant deployed successfully:', createRes.data);

    // 7. Verify new tenant is listed
    console.log('8. Verifying tenant listing...');
    const tenantsUpdatedRes = await axios.get(`${API_BASE}/tenants`, { headers });
    const newlyCreated = tenantsUpdatedRes.data.find((t: any) => t.id === testTenantId);
    if (newlyCreated) {
      console.log('   ✔ Newly created tenant successfully listed!');
      console.log('   Owner User ID:', newlyCreated.user_id);
    } else {
      throw new Error('Newly created tenant not found in list');
    }

    // 8. Test tenant status toggle (PUT /api/tenants/:id)
    console.log(`9. Toggling tenant status for ${testTenantId} to SUSPENDED...`);
    const putRes = await axios.put(`${API_BASE}/tenants/${testTenantId}`, {
      status: 'SUSPENDED'
    }, { headers });
    console.log('   Update response status:', putRes.data.status);
    if (putRes.data.status === 'SUSPENDED') {
      console.log('   ✔ Tenant suspension successfully completed!');
    } else {
      throw new Error('Tenant status was not updated to SUSPENDED');
    }

    // Revert back to trial plan for subsequent runs/testing
    if (trialPlan) {
      console.log(`10. Resetting subscription to Trial Plan (${trialPlan.id})...`);
      await axios.post(`${API_BASE}/subscriptions/me`, {
        plan_id: trialPlan.id,
        status: 'active'
      }, { headers });
      console.log('   Trial plan restored.');
    }

    console.log('\n=== All Tests Passed Successfully! ===');
  } catch (err: any) {
    console.error('*** Verification Failed ***');
    if (err.response) {
      console.error(`Status: ${err.response.status}`);
      console.error('Data:', JSON.stringify(err.response.data, null, 2));
    } else {
      console.error(err.message);
    }
    process.exit(1);
  }
}

run();
